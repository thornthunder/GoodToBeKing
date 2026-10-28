import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Client } from 'bedrock-protocol'
import {
  createBot,
  type Bot as MineflayerBot,
  type BotOptions as MineflayerBotOptions,
} from 'mineflayer-bedrock'
import type { BotAction, Brain, BrainContext, BuildOutcome, ChatEvent } from '../ai/Brain'
import { mentionsName, splitChatMessage } from '../ai/text'
import type { BotConfig, ServerConfig } from '../config'
import type { CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { useLanguage } from './language'
import { Builder } from '../build/Builder'
import { BuildLog, type BuildRecord } from '../build/BuildLog'
import {
  DEFAULT_PALETTE,
  makeBlueprint,
  rotate,
  type BlueprintId,
  type Palette,
} from '../build/blueprints'
import { Mason, type Job, type JobResult } from '../build/Mason'
import { findSite, type Point, type Site } from '../build/site'
import { SEE_THROUGH } from '../build/sites'
import { Vec3 as WorldVec } from 'vec3'
import type { ChatFloor } from './ChatFloor'
import { Movement } from './movement'
import type { CommandResult, Magic } from '../magic/Magic'
import type { SpellArgs } from '../magic/spells'
import { loadSkin } from './skin'
import {
  buildTextPacket,
  normalisePlayerList,
  parseTextPacket,
  type AddPlayerPacket,
  type CommandOutputPacket,
  type DisconnectPacket,
  type MovePlayerPacket,
  type PlayerListPacket,
  type RemoveEntityPacket,
  type RespawnPacket,
  type SetHealthPacket,
  type StartGamePacket,
  type TextPacket,
  type Vec3,
} from './packets'

/** createBot options that say where and how to reach the server (shared with the scripts). */
export function serverOptions(server: ServerConfig): MineflayerBotOptions {
  return {
    host: server.host,
    port: server.port,
    ...(server.version ? { version: server.version } : {}),
    ...(server.raknetBackend ? { raknetBackend: server.raknetBackend } : {}),
    ...(server.transport ? { transport: server.transport } : {}),
  } as MineflayerBotOptions
}

export type BotStatus = 'idle' | 'connecting' | 'joined' | 'spawned' | 'closed'

export interface PlayerInfo {
  uuid: string
  name: string
  /** Entity unique id from player_list / add_player (stable for the session). */
  uniqueId?: bigint
  /** Runtime entity id from add_player; only known while the player is in render distance. */
  runtimeId?: bigint
  /** Last known position; cleared when the player leaves render distance. */
  position?: Vec3
}

/** Wait this long after a join before hailing, so the newcomer has loaded in and sees chat. */
const JOIN_GREET_DELAY_MS = 4_000
/** A bot hears chat said within this many blocks (about across a great hall). */
const EARSHOT = 24

/** After a royal tells a bot on duty to stop, it leaves the duty alone this long. */
const DUTY_PAUSE_MS = 10 * 60_000

export interface BotOptions {
  /** Names of all bots run by this app: they never greet or answer each other. */
  fellowBots?: string[]
  /** Shared record of what each bot built. */
  buildLog?: BuildLog
  /** Shared: decides which bot answers a line. */
  floor?: ChatFloor
  /** The royal court, for duties (who to escort) and who counts as a guest. */
  court?: CourtRoster
  /** One line about the court's building works, for the brain's prompt. */
  works?: () => string | undefined
  /** Spells this bot can cast (Merlin; needs operator rights and cheats on). */
  magic?: Magic
}

export interface BotState {
  status: BotStatus
  runtimeId?: bigint
  position?: Vec3
  health?: number
  worldName?: string
  /** Other players by UUID, as reported by player_list / add_player. */
  players: Map<string, PlayerInfo>
}

/** bedrock-protocol sets a few properties at runtime that its typings leave out. */
interface BedrockClient extends Client {
  username?: string
  /** Resolved connection options; `version` is the negotiated Bedrock version. */
  options?: { version?: string }
  disconnect(reason?: string, hide?: boolean): void
}

/**
 * One Minecraft Bedrock player. Owns the protocol connection, keeps a small world state,
 * and routes chat to its Brain. Emits: 'spawn', 'chat' (ChatEvent), 'close'.
 */
export class Bot extends EventEmitter {
  readonly state: BotState = { status: 'idle', players: new Map() }
  private client?: BedrockClient
  /** mineflayer-bedrock bot: physics, world, pathfinding. Its `_client` is `client`. */
  private body?: MineflayerBot
  private movement?: Movement
  private builder?: Builder
  /** Works on sections of the court's great builds. */
  private mason?: Mason
  /** A royal asked for something else: no work orders until then. */
  private worksPausedUntil = 0
  private readonly worksSummary?: () => string | undefined
  private stopping = false
  private reconnectAttempts = 0
  private reconnectTimer?: NodeJS.Timeout
  /** Lower-cased names of all bots run by this app; they never greet or count each other. */
  private readonly botNames: Set<string>

  private readonly buildLog: BuildLog
  private readonly floor?: ChatFloor
  private readonly court?: CourtRoster
  private readonly magic?: Magic
  private dutyTimer?: NodeJS.Timeout
  /** The current follow comes from the bot's duty, not from someone asking. */
  private dutyFollowing = false
  /** A royal told the bot to stop: leave the duty alone until then. */
  private dutyPausedUntil = 0

  constructor(
    readonly cfg: BotConfig,
    private readonly brain: Brain,
    private readonly log: Logger,
    opts: BotOptions = {}
  ) {
    super()
    this.botNames = new Set([cfg.name, ...(opts.fellowBots ?? [])].map((n) => n.toLowerCase()))
    this.buildLog = opts.buildLog ?? new BuildLog()
    this.floor = opts.floor
    this.court = opts.court
    this.magic = opts.magic
    this.worksSummary = opts.works
  }

  /** May this bot speak for the court right now (hails, notices)? Always, without a floor. */
  private isHerald(forGuest = false): boolean {
    return !this.floor || this.floor.isHerald(this.cfg.name, forGuest)
  }

  /** The royal this bot should be escorting now (online and in sight), if it has that duty. */
  private dutyTarget(): string | undefined {
    const duty = this.cfg.duty
    const body = this.body
    if (duty?.kind !== 'escort' || !body) return undefined
    return duty.royals
      .map((title) =>
        this.court?.members.find((m) => m.title.toLowerCase() === title.toLowerCase())
      )
      .map((m) => m?.player)
      .find((player) => player && body.players[player]?.entity)
  }

  /**
   * Escort duty: follow the first royal (by title, in the duty's order) who is online and in
   * sight, unless the bot is busy with something it was asked to do or was told to stop. Duty
   * comes before the building works: a guard drops his work order when a royal appears.
   */
  private performDuty(): void {
    const movement = this.movement
    if (this.cfg.duty?.kind !== 'escort' || !movement || this.state.status !== 'spawned') return
    if (this.builder?.busy || Date.now() < this.dutyPausedUntil) return
    if (this.brain.post?.()) return // a royal's standing order comes before the duty
    const target = this.dutyTarget()
    const current = movement.current()
    if (current && !this.dutyFollowing) return // doing what someone asked
    if (!target) return
    if (this.mason?.busy) {
      this.log.info(`leaving the works to escort ${target}`)
      this.mason.cancel()
      return // follow on the next round, once the mason has let go
    }
    if (current?.kind === 'following' && current.target === target) return
    if (movement.follow(target, { distance: 3, quiet: true }) === 'ok') {
      this.dutyFollowing = true
      this.log.info(`on duty: escorting ${target}`)
    }
  }

  /** Free to take a work order from the court's building works. */
  canWork(): boolean {
    if (!this.cfg.works || this.state.status !== 'spawned' || !this.body || !this.mason)
      return false
    if (this.builder?.busy || this.mason.busy) return false
    if (Date.now() < this.worksPausedUntil) return false
    if (this.movement?.current() && !this.dutyFollowing) return false
    if (this.dutyTarget() && Date.now() >= this.dutyPausedUntil) return false
    if (this.brain.post?.()) return false // on a royal's orders
    return true
  }

  /** Every few seconds: the escort duty, standing orders, and reports owed to the superior. */
  private tick(): void {
    if (this.state.status !== 'spawned') return
    this.performDuty()
    this.keepPost()
    this.deliverReports()
    this.fadeGifts()
    this.watchMagic()
  }

  /** Work the spells a royal asked for, in order; if the server refuses one, say so and stop. */
  private async castSpell(action: Extract<BotAction, { type: 'cast' }>): Promise<void> {
    const magic = this.magic
    if (!magic) return
    for (const one of action.casts) {
      const spell = magic.find(one.spell)
      if (!spell) continue
      this.log.info(`casting ${spell.name} on ${one.target} for ${action.requestedBy}`)
      const result = await magic.cast(
        spell,
        one.args,
        { requester: action.requestedBy, target: one.target, merlin: this.username },
        (command) => this.command(command)
      )
      if (result.ok) continue
      this.log.warn(`${spell.name} failed: ${result.reason}`)
      // Refused for want of rights: the magic sleeps until someone types "op Merlin" again.
      if (result.reason?.includes('commands.generic.error.permissions')) {
        this.log.warn(`magic is asleep: type "op ${this.username}" in the server console`)
        magic.available = false
        this.lastMagicCheck = Date.now()
      }
      const who = this.court?.find(action.requestedBy)
      await this.speak(
        `Your spell ${spell.name} did not work (${result.reason}). Tell ${who ? `the ${who.title}` : action.requestedBy} ` +
          'so in one short sentence, kindly and in character.',
        `Alas, my ${spell.name} spell fizzled.`
      )
      return
    }
  }

  /** Cast a spell from the command file (for testing), checking it like a royal's request. */
  async castCommand(
    id: string,
    opts: { target: string; requestedBy: string; args: SpellArgs }
  ): Promise<void> {
    const spell = this.magic?.find(id)
    if (!this.magic || !spell) return void this.log.warn(`no such spell: ${id}`)
    const problem = this.magic.check(spell, opts.args)
    if (problem) return void this.log.warn(`cannot cast ${spell.name}: ${problem}`)
    await this.castSpell({
      type: 'cast',
      casts: [{ spell: spell.id, args: opts.args, target: opts.target }],
      requestedBy: opts.requestedBy,
    })
  }

  /** Log the spells and places this bot knows (command file: "<bot> spells"). */
  listSpells(): void {
    if (!this.magic) return void this.log.info('this bot works no magic')
    for (const s of this.magic.spells()) this.log.info(`spell ${s.id}: ${s.does}`)
    for (const p of this.magic.places()) this.log.info(`place ${p.name} at ${p.x} ${p.y} ${p.z}`)
    for (const g of this.magic.pendingGifts)
      this.log.info(`gift ${g.what} to ${g.to} fades ${new Date(g.until).toISOString()}`)
  }

  /** Take every gift back now (command file: "<bot> fade"), for testing. */
  async fadeGiftsNow(): Promise<void> {
    const magic = this.magic
    if (!magic) return
    const later = Date.now() + 25 * 3_600_000
    for (const gift of magic.due(() => true, later)) {
      const gone = await magic.takeBack(gift, (c) => this.command(c), later)
      this.log.info(`took back ${gift.what} from ${gift.to}: ${gone ? 'gone' : 'not found'}`)
    }
  }

  /** After spawning: may Merlin run commands? Without operator rights his magic sleeps. */
  private async checkMagic(): Promise<void> {
    const magic = this.magic
    if (!magic) return
    // Without rights the server refuses this one plainly; a bare "testfor" gets no answer at all.
    const result = await this.command('execute as @s run testfor @s')
    if (result.output.some((o) => o.startsWith('no answer'))) return // ask again later
    if (magic.available === result.ok) return
    magic.available = result.ok
    if (result.ok) this.log.info('magic is awake: the server lets this bot run commands')
    else
      this.log.warn(
        `magic is asleep (${result.output.join('; ')}): type "op ${this.username}" in the server console`
      )
  }

  private lastMagicCheck = 0

  /** While the magic sleeps (or is unknown), ask again every minute: someone may type "op". */
  private watchMagic(): void {
    const magic = this.magic
    if (!magic || magic.available === true || Date.now() - this.lastMagicCheck < 60_000) return
    this.lastMagicCheck = Date.now()
    void this.checkMagic()
  }

  private lastGiftCheck = 0

  /** A magic gift fades after a day: take it back once its owner is online, and say so. */
  private fadeGifts(): void {
    const magic = this.magic
    if (!magic || magic.available === false || Date.now() - this.lastGiftCheck < 60_000) return
    this.lastGiftCheck = Date.now()
    const online = new Set([...this.state.players.values()].map((p) => p.name.toLowerCase()))
    for (const gift of magic.due((name) => online.has(name.toLowerCase()))) {
      void magic
        .takeBack(gift, (command) => this.command(command))
        .then((gone) => {
          if (!gone) return
          this.log.info(`the gift ${gift.what} to ${gift.to} has faded`)
          const who = this.court?.find(gift.to)
          void this.speak(
            `Yesterday you gave ${who ? `the ${who.title}` : gift.to} a magic gift, ${gift.what}; ` +
              'its day is over and it has faded back into magic, as magic gifts do. Tell them ' +
              'kindly in one short sentence.',
            `The magic of yesterday's gift has faded, as all magic gifts do.`
          )
        })
    }
  }

  /** Keep following whom a standing order says to follow, whenever they are in sight. */
  private keepPost(): void {
    const post = this.brain.post?.()
    const movement = this.movement
    if (post?.type !== 'follow' || !movement || this.builder?.busy) return
    const current = movement.current()
    if (current?.kind === 'following' && current.target === post.target) return
    if (!this.body?.players[post.target]?.entity) return
    this.mason?.cancel()
    if (movement.follow(post.target, { quiet: true }) === 'ok') {
      this.dutyFollowing = false
      this.log.info(`on orders: following ${post.target}`)
    }
  }

  private lastReportAt = 0

  /**
   * Tell the superior about orders taken straight from a royal, once he is within earshot: now,
   * or the next time they meet.
   */
  private deliverReports(): void {
    const boss = this.cfg.reportsTo
    const reports = this.brain.pendingReports?.() ?? []
    if (!boss || reports.length === 0 || Date.now() - this.lastReportAt < 20_000) return
    const d = this.distanceTo(boss)
    if (d === undefined || d > EARSHOT) return
    this.lastReportAt = Date.now()
    this.brain.reported?.()
    this.log.info(`reporting to ${boss}: ${reports.join(' ')}`)
    void this.speak(
      `${boss}, whom you report to, is close by. Tell ${boss} by name, in one or two short ` +
        `sentences: ${reports.join(' ')}`,
      `${boss}, ${reports.join(' ')}`
    )
  }

  /** Fly a survey over the land (see Mason.survey). */
  async survey(
    points: Array<{ x: number; z: number }>,
    height: number,
    look: () => void
  ): Promise<void> {
    await this.mason?.survey(points, height, look)
  }

  /** Where the bot last went to rest between work orders. */
  private restingAt?: string

  /** Wait at a spot between work orders (once; it stays there until the next order). */
  rest(spot: Point): void {
    const k = `${spot.x},${spot.y},${spot.z}`
    if (this.restingAt === k || !this.mason || this.mason.busy || this.builder?.busy) return
    if (this.movement?.current()) return
    this.restingAt = k
    void this.mason.park(spot)
  }

  /** Build one section of the court's works. */
  async work(job: Job): Promise<JobResult> {
    const mason = this.mason
    this.restingAt = undefined
    if (!mason) return { placed: 0, dug: 0, missing: job.cells.length, blocked: 0, cancelled: true }
    if (this.dutyFollowing) this.dutyFollowing = false
    this.movement?.stop()
    return mason.work(job)
  }

  /** The top block of a column as this bot sees the world (null where nothing is loaded). */
  topAt(x: number, z: number): { y: number; name: string } | null {
    const body = this.body
    if (!body) return null
    for (let y = 130; y >= 30; y--) {
      const block = body.blockAt(new WorldVec(x, y, z))
      if (!block) return null
      if (SEE_THROUGH.test(block.name)) continue
      return { y, name: block.name }
    }
    return null
  }

  position(): Point | undefined {
    const p = this.body?.entity?.position
    return p ? { x: p.x, y: p.y, z: p.z } : undefined
  }

  /** Say something about the court's work, in character (the brain words it). */
  async speak(instruction: string, fallback?: string): Promise<string | null> {
    if (this.state.status !== 'spawned') return null
    try {
      const text = await this.brain.speak(instruction, this.context(), fallback)
      if (text) this.chat(text)
      return text
    } catch (err) {
      this.log.warn(`brain.speak failed: ${errMsg(err)}`)
      return null
    }
  }

  /** True for this bot itself and any other bot run by this app. */
  private isBot(name: string): boolean {
    return this.botNames.has(name.toLowerCase()) || name === this.username
  }

  /** Name as the server knows us (the gamertag in online mode). */
  get username(): string {
    return this.client?.username ?? this.cfg.name
  }

  get connected(): boolean {
    return this.state.status === 'joined' || this.state.status === 'spawned'
  }

  /** Connect and resolve once the bot has spawned in the world. */
  async connect(): Promise<void> {
    if (this.client) throw new Error(`${this.cfg.name} is already connected`)
    this.stopping = false
    const { server, auth } = this.cfg
    // Device-code sign-in needs a human, so give online mode far longer. Over Nethernet a spawn
    // takes 15-30 s when several bots join at once (start_game alone can take 25 s).
    const spawnTimeoutMs = auth.offline ? 90_000 : 300_000

    this.state.status = 'connecting'
    this.log.info(
      `connecting to ${server.host}:${server.port} as ${this.cfg.name} ` +
        `(${auth.offline ? 'offline' : 'microsoft'} auth` +
        `${server.version ? `, version ${server.version}` : ''})`
    )

    const options: MineflayerBotOptions = {
      ...serverOptions(server),
      username: this.cfg.name,
      auth: auth.offline ? 'offline' : 'microsoft',
      offline: auth.offline,
      profilesFolder: auth.profilesFolder,
      conLog: (...args: unknown[]) => this.log.info(args.map(String).join(' ')),
      onMsaCode: (data) =>
        this.log.warn(
          `Microsoft sign-in needed: open ${data.verification_uri} and enter code ${data.user_code}`
        ),
      hideErrors: true,
    }
    if (this.cfg.skin) {
      try {
        // bedrock-protocol merges `skinData` into the login's client data.
        Object.assign(options, { skinData: loadSkin(this.cfg.skin, this.cfg.name) })
      } catch (err) {
        this.log.warn(
          `could not load skin ${this.cfg.skin.texture}: ${errMsg(err)}; using the default`
        )
      }
    }

    // mineflayer-bedrock gives the bot a body (physics, world, pathfinding). Our own packet
    // handling stays on its bedrock-protocol client.
    const body = createBot(options)
    const client = body._client as unknown as BedrockClient
    this.body = body
    this.client = client
    this.movement = new Movement(body, this.log.child('move'))
    this.movement.onStuck = (target) => {
      this.brain
        .onStuck(target, this.context())
        .then((text) => {
          if (text) this.chat(text)
        })
        .catch((err) => this.log.warn(`brain.onStuck failed: ${errMsg(err)}`))
    }
    this.builder = new Builder(body, this.log.child('build'), this.buildLog, this.cfg.name)
    this.mason = new Mason(body, this.log.child('mason'))
    body.on('error', (err) => this.log.debug(`body error: ${errMsg(err)}`))
    body.once('spawn', () => this.movement?.configure())
    this.attachHandlers(client)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new Error(`no spawn within ${spawnTimeoutMs}ms`))
        client.close()
      }, spawnTimeoutMs)
      client.once('spawn', () => finish())
      client.once('close', () => finish(new Error('connection closed before spawn')))
      client.on('error', (err: unknown) =>
        finish(err instanceof Error ? err : new Error(String(err)))
      )
    })
  }

  /** Leave the server and stop any reconnect attempts. */
  async disconnect(reason = 'Leaving'): Promise<void> {
    this.stopping = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const client = this.client
    if (!client) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000)
      client.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      this.movement?.stop()
      if (this.body) this.body.quit(reason)
      else client.disconnect(reason)
    })
  }

  /** Carry out an action the brain asked for. */
  act(action: BotAction): void {
    const movement = this.movement
    if (!movement || this.state.status !== 'spawned') return
    switch (action.type) {
      case 'build':
        this.pauseWorks()
        void this.startBuild(action.blueprint, action.palette, action.requestedBy)
        return
      case 'undo':
        this.pauseWorks()
        void this.undoLastBuild(action.requestedBy)
        return
      case 'cast':
        void this.castSpell(action)
        return
      case 'stay':
        // A standing order: no works and no escort while it stands (see post()).
        this.builder?.cancel()
        this.mason?.cancel()
        movement.stop()
        this.dutyFollowing = false
        return
      case 'stop':
        this.builder?.cancel()
        this.pauseWorks()
        movement.stop()
        // A royal said stop: the escort duty waits too, for a while.
        this.dutyFollowing = false
        this.dutyPausedUntil = Date.now() + DUTY_PAUSE_MS
        return
      default: {
        this.builder?.cancel()
        this.pauseWorks()
        this.dutyFollowing = false
        this.dutyPausedUntil = 0
        const result =
          action.type === 'follow' ? movement.follow(action.target) : movement.comeTo(action.target)
        if (result !== 'ok') this.log.warn(`cannot ${action.type} ${action.target}: ${result}`)
      }
    }
  }

  /** A royal wants something else: put down the work order for a while. */
  private pauseWorks(): void {
    this.mason?.cancel()
    this.worksPausedUntil = Date.now() + DUTY_PAUSE_MS
  }

  /**
   * Build a blueprint near a player (or near `at`), inside the build zone, then tell the brain
   * how it went. Runs in the background; the bot keeps chatting while it builds.
   */
  async startBuild(
    blueprintId: BlueprintId,
    palette: Palette,
    requestedBy: string,
    at?: Point
  ): Promise<void> {
    const builder = this.builder
    const body = this.body
    const bp = makeBlueprint(blueprintId, palette)
    const report = (outcome: BuildOutcome) =>
      this.brain
        .onBuildDone(outcome, this.context())
        .then((text) => {
          if (text) this.chat(text)
        })
        .catch((err) => this.log.warn(`brain.onBuildDone failed: ${errMsg(err)}`))
    const fail = (reason: BuildOutcome['reason']) =>
      report({ title: bp.title, requestedBy, ok: false, placed: 0, total: bp.cells.length, reason })
    if (!builder || !body) return
    if (builder.busy) return void fail('busy')
    // Let go of any work order first (the mason stops at its next block).
    for (let i = 0; i < 50 && this.mason?.busy; i++) await new Promise((r) => setTimeout(r, 200))
    const zone = this.cfg.buildZone
    if (!zone) return void fail('no_zone')

    const requester = body.players[requestedBy]?.entity?.position
    const near = at ?? (requester ? { x: requester.x, y: requester.y, z: requester.z } : undefined)
    if (!near) return void fail('not_visible')
    if (Math.hypot(near.x - zone.center.x, near.z - zone.center.z) > zone.radius) {
      return void fail('outside_zone')
    }
    const avoid = Object.values(body.players)
      .map((p) => p.entity?.position)
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ x: p.x, y: p.y, z: p.z }))
    // An unfinished build of the same thing is resumed where it stands, not started again.
    const unfinished = this.buildLog.unfinished(this.cfg.name, blueprintId)
    const site = unfinished
      ? resumeSite(unfinished)
      : findSite(bp, builder.world(), {
          near,
          faceToward: requester ? near : undefined,
          avoid,
          zone,
          minDistance: at ? -1 : 2,
        })
    if (!site) return void fail('no_site')

    this.movement?.stop()
    const result = await builder.build(site, {
      title: bp.title,
      blueprint: bp.id,
      requestedBy,
      palette: unfinished?.palette ?? palette,
      resume: unfinished,
    })
    await report(result)
  }

  /**
   * Adopt a build that stands at a known spot but is not in the build log (or not complete), and
   * finish it there. Blocks of the blueprint already standing are counted as this bot's.
   */
  async resumeBuildAt(
    blueprintId: BlueprintId,
    origin: Point,
    quarterTurns: number,
    requestedBy: string
  ): Promise<void> {
    if (!this.builder || this.builder.busy) return
    const known = this.buildLog.unfinished(this.cfg.name, blueprintId)
    const record: BuildRecord = known ?? {
      id: `${this.cfg.name}-${Date.now()}`,
      bot: this.cfg.name,
      blueprint: blueprintId,
      title: makeBlueprint(blueprintId).title,
      requestedBy,
      origin,
      quarterTurns,
      palette: DEFAULT_PALETTE,
      fill: [],
      total: 0,
      complete: false,
      finishedAt: Date.now(),
      placed: [],
    }
    this.buildLog.upsert(record)
    await this.startBuild(blueprintId, record.palette, requestedBy, origin)
  }

  /** Take down the last thing this bot built (only its own blocks). */
  async undoLastBuild(requestedBy: string): Promise<void> {
    const builder = this.builder
    if (!builder || builder.busy) return
    this.movement?.stop()
    const result = await builder.undoLast()
    if (!result) {
      this.log.info('nothing to take down')
      return
    }
    await this.brain
      .onBuildDone(
        {
          title: result.title,
          requestedBy,
          undone: true,
          ok: true,
          placed: result.removed,
          total: result.removed,
        },
        this.context()
      )
      .then((text) => {
        if (text) this.chat(text)
      })
      .catch((err) => this.log.warn(`brain.onBuildDone failed: ${errMsg(err)}`))
  }

  /** Say something in public chat. Long text is split into chat-sized parts. */
  chat(message: string): void {
    const client = this.client
    if (!client || !this.connected) {
      this.log.warn(`not connected, dropping chat: ${message}`)
      return
    }
    for (const part of splitChatMessage(message)) {
      this.log.info(`<${this.username}> ${part}`)
      client.queue('text', buildTextPacket('chat', this.username, part))
    }
  }

  /** Say something to one player only (/tell needs no operator rights). */
  whisper(player: string, message: string): void {
    for (const part of splitChatMessage(message)) {
      this.log.info(`<${this.username} to ${player}> ${part}`)
      this.runCommand(`/tell "${player}" ${part}`)
    }
  }

  /**
   * Whether this bot hears a chat line: whispered to it, its turn to answer, named in it, or said
   * within earshot. Chat reaches every player on the server, but a bot only remembers what it
   * heard, so news travels through the court by being said where others can hear it.
   */
  private hears(event: ChatEvent, responder?: string | null): boolean {
    if (event.kind === 'whisper' || responder === this.cfg.name) return true
    if (mentionsName(event.message, this.cfg.name)) return true
    const d = this.distanceTo(event.from)
    return d !== undefined && d <= EARSHOT
  }

  /** How far a player (or fellow bot) stands from this bot, when both positions are known. */
  private distanceTo(name: string): number | undefined {
    const me = vec(this.body?.entity?.position) ?? this.state.position
    const lower = name.toLowerCase()
    const p = [...this.state.players.values()].find((x) => x.name.toLowerCase() === lower)
    const pos = p && (vec(this.body?.players[p.name]?.entity?.position) ?? p.position)
    return me && pos ? distance(me, pos) : undefined
  }

  /** Run a slash command (e.g. "/tell Steve hi"). Field layout verified against 1.26.x only. */
  runCommand(command: string, uuid: string = randomUUID()): void {
    const client = this.client
    if (!client || !this.connected) {
      this.log.warn(`not connected, dropping command: ${command}`)
      return
    }
    const text = command.startsWith('/') ? command : `/${command}`
    const modern = client.versionGreaterThanOrEqualTo('1.21.130')
    client.queue('command_request', {
      command: text,
      origin: {
        type: 'player',
        uuid,
        request_id: '',
        ...(modern ? { player_entity_id: 0n } : {}),
      },
      internal: false,
      version: modern ? 'latest' : 1,
    })
  }

  /** Run a command and wait for the server's answer: did it work, and on how many targets. */
  command(command: string, timeoutMs = 5_000): Promise<CommandResult> {
    const client = this.client
    if (!client || !this.connected) {
      return Promise.resolve({ ok: false, count: 0, output: ['not connected'] })
    }
    const uuid = randomUUID()
    return new Promise((resolve) => {
      const done = (result: CommandResult) => {
        clearTimeout(timer)
        client.removeListener('command_output', onOutput)
        this.log.info(`/${command} -> ${result.ok ? 'ok' : 'failed'} ${result.output.join('; ')}`)
        resolve(result)
      }
      const onOutput = (p: CommandOutputPacket) => {
        if (p.origin?.uuid !== uuid) return
        done({
          ok: p.success_count > 0,
          count: p.success_count,
          output: p.output.map((o) => [o.message_id, ...o.parameters].join(' ')),
        })
      }
      const timer = setTimeout(
        () => done({ ok: false, count: 0, output: ['no answer from the server'] }),
        timeoutMs
      )
      client.on('command_output', onOutput)
      this.runCommand(command, uuid)
    })
  }

  /** What the brain gets to know about the world. */
  context(): BrainContext {
    // Prefer the body's live physics positions; fall back to what the packets told us.
    const me = vec(this.body?.entity?.position) ?? this.state.position
    return {
      botName: this.username,
      players: [...this.state.players.values()]
        .filter((p) => !this.isBot(p.name))
        .map((p) => {
          const pos = vec(this.body?.players[p.name]?.entity?.position) ?? p.position
          return { name: p.name, distance: me && pos ? distance(me, pos) : undefined }
        }),
      position: me,
      activity:
        this.builder?.activity() ??
        this.mason?.activity() ??
        this.movement?.describe() ??
        undefined,
      works: this.cfg.works ? this.worksSummary?.() : undefined,
    }
  }

  private attachHandlers(client: BedrockClient): void {
    client.on('join', () => {
      this.state.status = 'joined'
      if (client.options?.version) useLanguage(client.options.version)
      this.log.info(`joined as ${this.username}`)
    })

    client.on('spawn', () => {
      this.state.status = 'spawned'
      this.reconnectAttempts = 0
      this.log.info(`spawned${this.state.position ? ` at ${fmtVec(this.state.position)}` : ''}`)
      this.floor?.setOnline(this.cfg.name, true)
      this.emit('spawn')
      clearInterval(this.dutyTimer)
      this.dutyTimer = setInterval(() => this.tick(), 3_000)
      // A new session: the server forgets offline players' operator rights, so ask again.
      if (this.magic) {
        this.magic.available = undefined
        this.lastMagicCheck = Date.now() - 50_000
      }
      // Only the herald greets on arrival; the rest of the court just takes its place.
      if (!this.isHerald()) return
      this.brain
        .onSpawn(this.context())
        .then((text) => {
          if (text) this.chat(text)
        })
        .catch((err) => this.log.warn(`brain.onSpawn failed: ${errMsg(err)}`))
    })

    client.on('start_game', (p: StartGamePacket) => {
      this.state.runtimeId = p.runtime_entity_id
      this.state.position = p.player_position
      this.state.worldName = p.world_name
      this.log.debug(`start_game: world="${p.world_name}" gamemode=${p.player_gamemode}`)
    })

    // The settled spawn point; start_game only carries a placeholder height (y ~ 32769).
    client.on('respawn', (p: RespawnPacket) => {
      if (p.state === 1) this.state.position = p.position
    })

    client.on('move_player', (p: MovePlayerPacket) => {
      const id = BigInt(p.runtime_id)
      if (id === this.state.runtimeId) {
        this.state.position = p.position
        return
      }
      const player = this.playerByRuntimeId(id)
      if (player) player.position = p.position
    })

    client.on('remove_entity', (p: RemoveEntityPacket) => {
      for (const player of this.state.players.values()) {
        if (player.uniqueId === p.entity_id_self) {
          player.position = undefined
          player.runtimeId = undefined
        }
      }
    })

    client.on('set_health', (p: SetHealthPacket) => {
      this.state.health = p.health
    })

    client.on('player_list', (p: PlayerListPacket) => {
      for (const { type, record } of normalisePlayerList(p)) {
        if (type === 'remove') {
          const gone = this.state.players.get(record.uuid)
          this.state.players.delete(record.uuid)
          if (gone && !this.isBot(gone.name)) {
            this.log.info(`${gone.name} left`)
            this.brain.onPlayerLeave?.(gone.name)
          }
          if (gone) this.movement?.forget(gone.name)
          continue
        }
        if (!record.username) continue
        const known = this.state.players.get(record.uuid)
        if (known) {
          known.name = record.username
          known.uniqueId ??= record.entity_unique_id
          continue
        }
        this.state.players.set(record.uuid, {
          uuid: record.uuid,
          name: record.username,
          uniqueId: record.entity_unique_id,
        })
        // Players listed before we spawned were already here; only later additions are joins.
        if (this.state.status === 'spawned') this.onPlayerJoin(record.username)
      }
    })

    client.on('add_player', (p: AddPlayerPacket) => {
      const existing = this.state.players.get(p.uuid)
      if (existing) {
        existing.runtimeId = p.runtime_id
        existing.uniqueId ??= p.unique_id
        existing.position = p.position
      } else {
        this.state.players.set(p.uuid, {
          uuid: p.uuid,
          name: p.username,
          runtimeId: p.runtime_id,
          uniqueId: p.unique_id,
          position: p.position,
        })
      }
    })

    client.on('text', (p: TextPacket) => this.onText(p))

    client.on('kick', (p: DisconnectPacket) => {
      const detail = p.message ? ` "${p.message}"` : ''
      this.log.warn(`kicked: reason=${p.reason}${detail}`)
      if (p.reason === 'not_authenticated' && this.cfg.auth.offline) {
        this.log.warn(
          'the server requires Xbox Live authentication: set MC_OFFLINE=false (Microsoft sign-in) ' +
            'or switch the server to online-mode=false'
        )
      }
    })

    client.on('error', (err: unknown) => {
      this.log.error(`client error: ${errMsg(err)}`)
    })

    client.on('close', () => {
      this.client = undefined
      this.body = undefined
      this.movement = undefined
      this.builder?.cancel()
      this.builder = undefined
      this.mason?.cancel()
      this.mason = undefined
      clearInterval(this.dutyTimer)
      this.dutyFollowing = false
      this.floor?.setOnline(this.cfg.name, false)
      this.state.status = 'closed'
      this.state.players.clear()
      this.state.runtimeId = undefined
      this.log.info('connection closed')
      this.emit('close')
      if (!this.stopping && this.cfg.autoReconnect) this.scheduleReconnect()
    })
  }

  private onText(packet: TextPacket): void {
    const event = parseTextPacket(packet)
    if (!event) {
      this.log.debug(`text(${packet.type}): ${packet.message}`)
      return
    }
    if (event.kind === 'system') {
      this.log.info(`[server] ${event.message}`)
      this.emit('chat', event)
      if (event.notice && this.state.status === 'spawned' && this.isHerald()) {
        this.brain
          .onNotice(event, this.context())
          .then((reply) => {
            if (reply) this.chat(reply)
          })
          .catch((err) => this.log.warn(`brain.onNotice failed: ${errMsg(err)}`))
      }
      return
    }
    this.log.info(`<${event.from}> ${event.message}`)
    this.emit('chat', event)
    if (event.from === this.username) return
    // Never talk to the rest of the court: bots answering bots would never stop. But listen:
    // what a bot hears the others tell the royals, it remembers.
    if (this.isBot(event.from)) {
      this.brain.onCourtLine?.(event, { ...this.context(), hears: this.hears(event) })
      return
    }

    // One bot answers a line: the one named, the one already talking with them, or the herald.
    const fromGuest = !this.court?.find(event.from)
    const responder =
      event.kind === 'whisper' || !this.floor
        ? this.cfg.name
        : this.floor.responder(event, fromGuest)
    const ctx = {
      ...this.context(),
      mayReply: responder === this.cfg.name,
      hears: this.hears(event, responder),
    }
    this.brain
      .onChat(event, ctx)
      .then((reply) => {
        if (reply?.say) {
          // A whisper is answered by whisper: what was told in secret stays between the two.
          if (event.kind === 'whisper') this.whisper(event.from, reply.say)
          else this.chat(reply.say)
          this.floor?.replied(this.cfg.name, event.from)
        }
        if (reply?.action) this.act(reply.action)
      })
      .catch((err) => this.log.warn(`brain.onChat failed: ${errMsg(err)}`))
  }

  private onPlayerJoin(name: string): void {
    if (this.isBot(name)) return
    this.log.info(`${name} joined`)
    this.emit('playerJoin', name)
    setTimeout(() => {
      if (!this.connected) return
      // The herald (the Castellan for guests) does the welcoming for the whole court.
      if (!this.isHerald(!this.court?.find(name))) return
      const stillHere = [...this.state.players.values()].some((p) => p.name === name)
      if (!stillHere) {
        this.log.debug(`not greeting ${name}: already gone`)
        return
      }
      this.brain
        .onPlayerJoin(name, this.context())
        .then((text) => {
          if (text) this.chat(text)
        })
        .catch((err) => this.log.warn(`brain.onPlayerJoin failed: ${errMsg(err)}`))
    }, JOIN_GREET_DELAY_MS)
  }

  private playerByRuntimeId(id: bigint): PlayerInfo | undefined {
    for (const player of this.state.players.values()) {
      if (player.runtimeId === id) return player
    }
    return undefined
  }

  private scheduleReconnect(): void {
    const delay = Math.min(60_000, 2_000 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.log.info(
      `reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect().catch((err) => this.log.warn(`reconnect failed: ${errMsg(err)}`))
    }, delay)
  }
}

/** Plain {x,y,z} from a vec3 instance, skipping the unset origin a body has before spawning. */
function vec(v: Vec3 | undefined): Vec3 | undefined {
  if (!v || (v.x === 0 && v.y === 0 && v.z === 0)) return undefined
  return { x: v.x, y: v.y, z: v.z }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function fmtVec(v: Vec3): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`
}

/** The site of an unfinished build, rebuilt from its record. */
function resumeSite(record: BuildRecord): Site {
  const blueprint = rotate(
    makeBlueprint(record.blueprint as BlueprintId, record.palette),
    record.quarterTurns
  )
  return { origin: record.origin, blueprint, quarterTurns: record.quarterTurns, fill: record.fill }
}
