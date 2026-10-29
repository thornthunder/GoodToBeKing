import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Client } from 'bedrock-protocol'
import {
  createBot,
  type Bot as MineflayerBot,
  type BotOptions as MineflayerBotOptions,
} from 'mineflayer-bedrock'
import type {
  BotAction,
  Brain,
  BrainContext,
  BuildOutcome,
  ChatEvent,
  GameMode,
  HallWork,
} from '../ai/Brain'
import { byHand } from '../ai/Brain'
import { mentionsName, splitChatMessage } from '../ai/text'
import type { BotConfig, ServerConfig } from '../config'
import type { CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { useLanguage } from './language'
import { BuildLog, type BuildRecord } from '../build/BuildLog'
import {
  DEFAULT_PALETTE,
  makeBlueprint,
  rotate,
  type BlueprintId,
  type Palette,
} from '../build/blueprints'
import type { PlanCell } from '../build/compile'
import { Mason, type Job, type JobResult } from '../build/Mason'
import { findSite, type Point, type Site } from '../build/site'
import { SEE_THROUGH } from '../build/sites'
import { Vec3 as WorldVec } from 'vec3'
import type { ChatFloor } from './ChatFloor'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { chooseFarm } from '../build/farm'
import { Handbuilder } from '../build/Handbuilder'
import {
  bedCells,
  chestCells,
  doorCells,
  floorCells,
  furnaceCells,
  reinforceCells,
  lightCells,
  repairCells,
  roofCells,
  surveyHall,
  tableCells,
  type Hall,
  type HandCell,
} from '../build/hall'
import type { Household } from '../household'
import { Cook } from './cooking'
import { craft, makePlanks } from './crafting'
import { Farmer } from './farming'
import { Miner, chooseMine } from './mining'
import { Gatherer, type Material } from './gathering'
import { GAME, Hunter, SPOILS } from './hunting'
import { FOODS, Survival, isNight } from './survival'
import { Movement } from './movement'
import type { CommandResult, Magic } from '../magic/Magic'
import type { SpellArgs } from '../magic/spells'
import { loadSkin } from './skin'
import {
  buildTextPacket,
  fixOutgoing,
  metadataTarget,
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
    ...(server.webrtc ? { nethernet: { webrtcBackend: server.webrtc } } : {}),
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

const FOOD_ITEM = new RegExp(`^(${FOODS.join('|')})$`)

/** Hall work as the builder speaks of it, and the cells it takes. */
const HALL_WORK_TITLES: Record<HallWork, string> = {
  roof: 'a roof',
  floor: 'a plank floor',
  light: 'torches',
  door: 'a door',
  beds: 'beds',
  repair: 'repairs',
  furnace: 'a furnace',
  chest: 'a chest for the storehouse',
  reinforce: 'stone walls',
  table: 'a crafting table',
}
const HALL_WORK_CELLS: Record<
  HallWork,
  (hall: Hall, names: (x: number, y: number, z: number) => string | undefined) => HandCell[]
> = {
  roof: roofCells,
  floor: floorCells,
  light: lightCells,
  door: doorCells,
  // As many beds as the builder carries or the storehouse holds (one for each courtier, at most).
  beds: (hall, names) => bedCells(hall, names, 8),
  repair: repairCells,
  furnace: furnaceCells,
  chest: chestCells,
  reinforce: reinforceCells,
  table: tableCells,
}

/** bedboo reads a bed's state from its block (not in mineflayer-bedrock's types). */
interface BedReader {
  parseBedMetadata(bed: unknown): { occupied?: boolean; part?: boolean }
}

/** Beds a bot is on its way to, so two bots never make for the same one. */
const claimedBeds = new Map<string, string>()

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
  /** The court's home and storehouse (survival), shared by the court. */
  household?: Household
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
  /** Decodes one packet of a batch and emits it. */
  readPacket(packet: Buffer): void
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
  /** Works on sections of the court's great builds, and raises the small builds royals ask for. */
  private mason?: Mason
  /** Raising (or taking down) a build a royal asked for. */
  private building = false
  /** Out fetching something for a royal (survival). */
  private gatherer?: Gatherer
  private gathering = false
  /** Taken a hall job (busy from the moment it takes it, not only once it builds). */
  private onHallWork = false
  /** Builds by hand in survival (the hall's roof, floor, light and door). */
  private handbuilder?: Handbuilder
  /** Hunting and cooking for the court's food (survival). */
  private hunter?: Hunter
  private cook?: Cook
  private farmer?: Farmer
  private miner?: Miner
  /** Eating and, for guards, fighting (survival). */
  private survival?: Survival
  private died = false
  private lastDeathWords = 0
  private surviving = false
  /** The court's home and storehouse (survival). */
  private readonly household?: Household
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
    this.household = opts.household
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
    // Escort only when asked (a royal's "escort me" is a follow order), unless set to follow by itself.
    if (!this.cfg.duty.auto) return
    if (this.building || Date.now() < this.dutyPausedUntil) return
    // An errand (hunting, fetching, building by hand) is finished first.
    if (this.gathering || this.handbuilder?.busy) return
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
    // Put down for a while after a royal's request: the castle works wait (other work does not).
    if (Date.now() < this.worksPausedUntil) return false
    return Boolean(this.cfg.works) && this.buildsByMagic() && this.isFree()
  }

  /** The game mode the server gave this bot; undefined until it said. */
  gameMode(): GameMode | undefined {
    return this.body?.game?.gameMode as GameMode | undefined
  }

  /**
   * The mason builds like a creative player (flight, the creative inventory). In survival every
   * block must be gathered and laid by hand, which the court cannot do yet.
   */
  buildsByMagic(): boolean {
    return !byHand(this.gameMode())
  }

  /** Idle: not building, not walking for anyone, not on duty or a royal's post. */
  isFree(): boolean {
    if (this.state.status !== 'spawned' || !this.body || !this.mason) return false
    if (this.building || this.mason.busy || this.gathering || this.handbuilder?.busy) return false
    if (this.onHallWork) return false
    if (this.survival?.busy) return false
    const walking = this.movement?.current()
    if (walking && !this.dutyFollowing && walking.kind !== 'going') return false
    if (this.cfg.duty?.auto && this.dutyTarget() && Date.now() >= this.dutyPausedUntil) return false
    if (this.brain.post?.()) return false // on a royal's orders
    return true
  }

  /** Every few seconds: the escort duty, standing orders, and reports owed to the superior. */
  private tick(): void {
    if (this.state.status !== 'spawned') return
    // Asleep: nothing to do till morning (or till a royal speaks to it).
    if (this.body?.isSleeping) return
    this.lookAfterSelf()
    this.askForSword()
    this.performDuty()
    this.keepPost()
    this.deliverReports()
    this.fadeGifts()
    this.watchMagic()
  }

  /** In survival: eat, fight (guards), and close doors left open. One round at a time. */
  private lookAfterSelf(): void {
    const survival = this.survival
    if (!survival || this.surviving || !byHand(this.gameMode())) return
    this.surviving = true
    survival
      .tick()
      .then(() => (this.isFree() ? survival.closeDoors() : undefined))
      .catch((err) => this.log.warn(`looking after itself failed: ${errMsg(err)}`))
      .finally(() => (this.surviving = false))
  }

  private lastSwordAsk = 0

  /** A guard without a weapon asks the King for a sword by Merlin's magic (survival). */
  private askForSword(): void {
    const body = this.body
    if (!body || this.cfg.duty?.kind !== 'escort' || !byHand(this.gameMode())) return
    if (Date.now() - this.lastSwordAsk < 30 * 60_000) return
    if (body.inventory.items().some((i) => /_(sword|axe)$/.test(i.name))) return
    const king = this.court?.members.find((m) => m.role === 'king')
    const pos = king && body.players[king.player]?.entity?.position
    const me = body.entity?.position
    if (!king || !pos || !me || pos.distanceTo(me) > 24) return
    this.lastSwordAsk = Date.now()
    this.log.info('asking the King for a sword')
    void this.speak(
      `You are a guard of the royal family with no sword to protect them. Ask the King politely, ` +
        'in one short sentence and in character, whether he would have Merlin conjure you one.',
      'Your Majesty, might Merlin conjure me a sword, so I can guard the court?'
    )
  }

  /**
   * A royal went to bed at night: go to a free bed near home and sleep too, so the night can
   * pass (survival). Two bots never make for the same bed.
   */
  async goToBed(): Promise<void> {
    const body = this.body
    if (!body || body.isSleeping || !byHand(this.gameMode()) || !this.isNight()) return
    if (this.gathering || this.handbuilder?.busy || this.survival?.busy) return
    const near = this.household?.home ?? this.position()
    if (!near) return
    const beds = body
      .findBlocks({
        matching: (b: { name: string }) => /bed$/.test(b.name),
        point: new WorldVec(near.x, near.y, near.z),
        maxDistance: 32,
        count: 40,
      })
      .map((p) => body.blockAt(p))
      .filter((b): b is NonNullable<typeof b> => !!b && body.isABed(b))
      .filter((b) => {
        const meta = (body as unknown as BedReader).parseBedMetadata(b)
        const claim = claimedBeds.get(`${b.position}`)
        return !meta.occupied && !meta.part && (!claim || claim === this.cfg.name)
      })
    const me = body.entity.position
    const bed = beds.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (!bed) return void this.log.info('wants to sleep, but there is no free bed')
    claimedBeds.set(`${bed.position}`, this.cfg.name)
    this.movement?.stop()
    this.dutyFollowing = false
    const walker = body as unknown as { pathfinder: Pathfinder }
    try {
      const p = bed.position
      await withTimeout(walker.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), 30_000)
      await withTimeout(body.sleep(bed), 10_000)
      this.log.info(`sleeping in the bed at ${p}`)
    } catch (err) {
      this.log.info(`could not sleep: ${errMsg(err)}`)
      walker.pathfinder.setGoal(null)
      claimedBeds.delete(`${bed.position}`)
    }
  }

  /**
   * Tap a bed near home so this courtier respawns there instead of at the world spawn (in
   * Bedrock a bed sets the respawn point by day too). Returns the bed it tapped.
   */
  async setSpawnAtBed(): Promise<{ x: number; y: number; z: number } | undefined> {
    const body = this.body
    const home = this.household?.home
    if (!body || !home || !byHand(this.gameMode()) || !this.isFree()) return undefined
    const bed = body
      .findBlocks({
        matching: (b: { name: string }) => /bed$/.test(b.name),
        point: new WorldVec(home.x, home.y, home.z),
        maxDistance: 16,
        count: 1,
      })
      .map((p) => body.blockAt(p))[0]
    if (!bed) return undefined
    const walker = body as unknown as { pathfinder: Pathfinder }
    try {
      const p = bed.position
      await withTimeout(walker.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), 30_000)
      // The server's "Respawn point set" comes as a pop-up the court does not read; a tap that
      // went through sets it (tried: a bot killed after tapping by day woke by the bed).
      await body.activateBlock(bed)
    } catch (err) {
      walker.pathfinder.setGoal(null)
      this.log.info(`could not get to a bed to set my spawn: ${errMsg(err)}`)
      return undefined
    }
    this.log.info(`respawn point set at the bed at ${bed.position}`)
    return { x: bed.position.x, y: bed.position.y, z: bed.position.z }
  }

  /** Where the royals in sight stand. */
  private royalPositions(): WorldVec[] {
    const body = this.body
    if (!body || !this.court) return []
    return [...this.state.players.values()]
      .filter((p) => this.court?.find(p.name))
      .map((p) => body.players[p.name]?.entity?.position)
      .filter((p): p is WorldVec => p !== undefined)
  }

  /** Take some food out of the storehouse (survival); returns how many, undefined when busy. */
  private async fetchFood(): Promise<number | undefined> {
    const chest = this.household?.storehouse
    const gatherer = this.gatherer
    if (!chest || !gatherer) return 0
    if (!this.isFree()) return undefined
    const count = () =>
      this.body?.inventory
        .items()
        .filter((i) => FOOD_ITEM.test(i.name))
        .reduce((n, i) => n + i.count, 0) ?? 0
    const before = count()
    await gatherer.withChest(chest, async (window) => {
      let left = 4
      for (const item of window.containerItems().filter((i) => FOOD_ITEM.test(i.name))) {
        if (left <= 0) break
        const n = Math.min(left, item.count)
        await window.withdraw(item.type, item.metadata, n)
        left -= n
      }
      return 0
    })
    if (gatherer.lastStock) this.household?.noteStock(gatherer.lastStock)
    return Math.max(0, count() - before)
  }

  /** Night in this bot's world (monsters about). */
  isNight(): boolean {
    return isNight(this.body?.time?.timeOfDay)
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
    // Unknown (just arrived, or the server did not answer yet): ask often; refused: once a minute.
    const every = magic?.available === undefined ? 20_000 : 60_000
    if (!magic || magic.available === true || Date.now() - this.lastMagicCheck < every) return
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
    if (post?.type !== 'follow' || !movement || this.building) return
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
    if (this.restingAt === k || !this.mason || this.mason.busy || this.building) return
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

  /** Metadata worth decoding: the bot's own (flight, air, beds) and other players'. */
  private wantsMetadata(entity: bigint): boolean {
    if (this.state.runtimeId === undefined || entity === this.state.runtimeId) return true
    for (const p of this.state.players.values()) if (p.runtimeId === entity) return true
    // Game animals: their name tags, babies and leashes decide whether they may be hunted.
    const name = this.body?.entities[Number(entity)]?.name
    return name !== undefined && GAME.test(name)
  }

  /** Where a player stands, if this bot can see them. */
  playerPosition(name: string): Point | undefined {
    const p = this.body?.players[name]?.entity?.position
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
    // The court never looks at mobs' metadata, and around the village decoding it was the
    // heaviest work of six bots (protodef builds an object of every flag for each update). Only
    // the bot's own and other players' metadata are decoded.
    const read = client.readPacket.bind(client)
    client.readPacket = (packet: Buffer) => {
      const target = metadataTarget(packet)
      if (target !== undefined && !this.wantsMetadata(target)) return
      read(packet)
    }
    // Item stack requests carry bedboo's 1.26.51 action bytes: fix them for 1.26.60 (packets.ts).
    const queue = client.queue.bind(client)
    const write = client.write.bind(client)
    client.queue = (name: string, params: object) => {
      fixOutgoing(name, params)
      queue(name, params)
    }
    client.write = (name: string, params: object) => {
      fixOutgoing(name, params)
      write(name, params)
    }
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
    this.mason = new Mason(body, this.log.child('mason'))
    this.gatherer = new Gatherer(body, this.log.child('gather'), (name) => this.isBot(name))
    this.hunter = new Hunter(body, this.log.child('hunt'), (name) => this.isBot(name))
    this.cook = new Cook(body, this.log.child('cook'), this.gatherer)
    this.farmer = new Farmer(body, this.log.child('farm'), this.gatherer)
    this.miner = new Miner(body, this.log.child('mine'))
    this.handbuilder = new Handbuilder(body, this.log.child('hands'), this.gatherer, () =>
      this.movement?.configure()
    )
    body.on('error', (err) => this.log.debug(`body error: ${errMsg(err)}`))
    // Doors only in survival: in the creative world the bots open nobody's door.
    body.once('spawn', () => this.movement?.configure(byHand(this.gameMode())))
    this.survival = new Survival(body, this.log.child('life'), {
      guard: this.cfg.duty?.kind === 'escort',
      royals: () => this.royalPositions(),
      fetchFood: () => this.fetchFood(),
      speak: (instruction, fallback) => this.speak(instruction, fallback),
    })
    // The bed it respawned at was gone: it woke at the world spawn, and must tap a bed again.
    ;(body as unknown as NodeJS.EventEmitter).on('spawnReset', () => {
      this.log.info('my bed was gone: respawned at the world spawn')
      this.household?.setSpawn(this.cfg.name, undefined)
    })
    body.on('death', () => {
      this.log.info('died')
      this.died = true
      this.gatherer?.cancel()
      this.handbuilder?.cancel()
    })
    body.on('respawn', () => {
      if (!this.died) return
      this.died = false
      this.log.info(`back after dying, at ${fmtVec(this.position() ?? { x: 0, y: 0, z: 0 })}`)
      // Said once in a while, not at every death of a bad night.
      if (Date.now() - this.lastDeathWords < 10 * 60_000) return
      this.lastDeathWords = Date.now()
      setTimeout(() => {
        void this.speak(
          'You just died (in survival, monsters, falls and drowning are real) and woke up again ' +
            'at the spawn point. Say so lightly in one short sentence, in character, and that you ' +
            'will be back soon.',
          'Oof! I shall be right back.'
        )
      }, 3_000)
    })
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
      case 'commission': {
        // The court keeps the request (see BotManager); without one, a builder just builds.
        const request = {
          blueprint: action.blueprint,
          palette: action.palette,
          requestedBy: action.requestedBy,
          near: this.playerPosition(action.requestedBy),
          own: action.type === 'build',
        }
        if (this.listenerCount('commission') > 0) this.emit('commission', request)
        else if (action.type === 'build') {
          this.pauseWorks()
          void this.startBuild(action.blueprint, action.palette, action.requestedBy)
        }
        return
      }
      case 'undo':
        this.pauseWorks()
        void this.undoLastBuild(action.requestedBy)
        return
      case 'works':
        // The court plans it (see BotManager): here, or at the coordinates the royal gave.
        this.emit('works', {
          what: action.what,
          requestedBy: action.requestedBy,
          near: action.at ?? this.playerPosition(action.requestedBy),
        })
        return
      case 'cast':
        void this.castSpell(action)
        return
      case 'gather':
        // The Castellan's errands go to whichever of his staff is free (see BotManager).
        if (action.delegate) this.emit('gather', { ...action, from: this.cfg.name })
        else
          void this.startGather(action.material, action.count, action.requestedBy, action.toStore)
        return
      case 'hallwork':
        // The Castellan's hall work goes to whichever of his builders is free (see BotManager).
        if (action.delegate) this.emit('hallwork', { ...action, from: this.cfg.name })
        else void this.startHallWork(action.work, action.requestedBy)
        return
      case 'home':
        // The court keeps it (see BotManager): where the royal stands, or failing that, here.
        this.emit('home', {
          requestedBy: action.requestedBy,
          at: this.playerPosition(action.requestedBy) ?? this.position(),
        })
        return
      case 'storehouse':
        void this.chooseStorehouse(action.requestedBy)
        return
      case 'stay':
        // A standing order: no works and no escort while it stands (see post()).
        this.mason?.cancel()
        movement.stop()
        this.dutyFollowing = false
        return
      case 'stop':
        this.pauseWorks()
        this.gatherer?.cancel()
        this.handbuilder?.cancel()
        movement.stop()
        // A royal said stop: the escort duty waits too, for a while.
        this.dutyFollowing = false
        this.dutyPausedUntil = Date.now() + DUTY_PAUSE_MS
        return
      default: {
        this.pauseWorks()
        this.dutyFollowing = false
        this.dutyPausedUntil = 0
        const result =
          action.type === 'follow' ? movement.follow(action.target) : movement.comeTo(action.target)
        if (result !== 'ok') this.log.warn(`cannot ${action.type} ${action.target}: ${result}`)
      }
    }
  }

  /**
   * Fetch a material by hand for a royal (survival): dig it from untouched land well away from
   * everyone, bring it back, toss it over, and say how it went.
   */
  async startGather(
    material: Material,
    count: number,
    requestedBy: string,
    toStore = false
  ): Promise<number> {
    const gatherer = this.gatherer
    if (!gatherer || this.gathering) return 0
    const chest = toStore ? this.household?.storehouse : undefined
    if (toStore && !chest) {
      this.log.warn('no storehouse to fetch for')
      return 0
    }
    this.gathering = true
    this.pauseWorks()
    this.dutyFollowing = false
    this.movement?.stop()
    const member = this.court?.find(requestedBy)
    const who = member ? `the ${member.title}` : requestedBy
    const name = material === 'wood' ? 'logs' : material
    try {
      this.log.info(`fetching ${count} ${material} for ${chest ? 'the storehouse' : requestedBy}`)
      const result = await gatherer.fetch(
        material,
        count,
        chest ? { chest } : { player: requestedBy }
      )
      if (gatherer.lastStock) this.household?.noteStock(gatherer.lastStock)
      if (result.reason === 'cancelled') return result.gathered
      // The court's own errands (housekeeping) say nothing of a failure: it would be every minute.
      if (!member && result.gathered === 0) return 0
      if (chest && result.delivered > 0) {
        await this.speak(
          `You fetched ${result.delivered} ${name}, dug by hand, and put them in the storehouse ` +
            `as ${who} asked. It now holds ${this.household?.stockWords() ?? 'that'}. Say so in one short sentence.`,
          `${result.delivered} ${name} are in the storehouse now!`
        )
      } else if (chest && result.gathered > 0) {
        await this.speak(
          `You gathered ${result.gathered} ${name} for the storehouse but could not put them in ` +
            'the chest (it is gone, or out of reach); you keep them. Say so in one short sentence.',
          `I have the ${name}, but I could not get them into the storehouse.`
        )
      } else if (result.delivered > 0) {
        await this.speak(
          `You fetched ${result.delivered} ${name} for ${who}, dug by hand, and have just tossed ` +
            `them over. Say so in one short, cheerful sentence${result.delivered < count ? ' (it is all you could find nearby)' : ''}.`,
          `Here you are: ${result.delivered} ${name}!`
        )
      } else if (result.gathered > 0) {
        await this.speak(
          `You gathered ${result.gathered} ${name} for ${who} but could not find them to hand ` +
            'it over; you keep it for them. Say so in one short sentence.',
          `I have your ${name}, but I could not find you!`
        )
      } else {
        await this.speak(
          `You looked for untouched ${name} for ${who}, well away from everyone's building, and ` +
            'found none nearby. Say so kindly in one short sentence.',
          `Alas, I found no ${name} nearby that nobody is using.`
        )
      }
      return result.gathered
    } catch (err) {
      this.log.warn(`fetching ${material} failed: ${errMsg(err)}`)
      return 0
    } finally {
      this.gathering = false
    }
  }

  /**
   * Work on the court's home hall by hand: survey it from its walls, build the cells (materials
   * from the storehouse, more wood chopped if short), and say how it went.
   */
  async startHallWork(work: HallWork, requestedBy: string): Promise<boolean> {
    const builder = this.handbuilder
    const home = this.household?.home
    if (!builder || builder.busy || this.onHallWork || !home || !this.body) return false
    this.onHallWork = true
    try {
      return await this.hallWork(builder, home, work, requestedBy)
    } finally {
      this.onHallWork = false
    }
  }

  private async hallWork(
    builder: Handbuilder,
    home: { x: number; y: number; z: number },
    work: HallWork,
    requestedBy: string
  ): Promise<boolean> {
    if (!this.body) return false
    const royal = Boolean(this.court?.find(requestedBy))
    const member = this.court?.find(requestedBy)
    const who = member ? `the ${member.title}` : requestedBy
    const title = HALL_WORK_TITLES[work]
    this.pauseWorks()
    this.dutyFollowing = false
    this.movement?.stop()
    // Close enough to see the hall: its walls must be loaded to be surveyed.
    if (
      this.position() &&
      Math.hypot(this.position()!.x - home.x, this.position()!.z - home.z) > 24
    ) {
      this.movement?.goTo(home, 'home')
      for (let i = 0; i < 60 && this.movement?.current()?.kind === 'going'; i++) await sleep(1_000)
    }
    const body = this.body
    const names = (x: number, y: number, z: number) => body.blockAt(new WorldVec(x, y, z))?.name
    const surveyed = surveyHall(names, home)
    // Whole: remember its shape. Damaged: the shape last seen whole says where it was.
    if (typeof surveyed !== 'string') this.household?.setHall(surveyed)
    const saved = this.household?.hall
    const hall: Hall | string = typeof surveyed === 'string' && saved ? saved : surveyed
    if (typeof surveyed === 'string' && saved)
      this.log.info(`the hall is damaged (${surveyed}); working from its shape as last seen`)
    if (typeof hall === 'string') {
      this.log.info(`cannot survey the hall: ${hall}`)
      if (!royal) return false
      await this.speak(
        `${who} asked for ${title}, but looking at the hall: ${hall}. Say so kindly in one short sentence.`,
        `Alas, I cannot make out the hall: ${hall}.`
      )
      return false
    }
    const cells = HALL_WORK_CELLS[work](hall, names)
    if (cells.length === 0) {
      if (!royal) return true
      await this.speak(
        `${who} asked for ${title}, and the hall already has it. Say so in one short sentence.`,
        `The hall already has ${title}!`
      )
      return true
    }
    this.log.info(
      `${title} for the hall: ${cells.length} blocks (${hall.inside.length} columns inside)`
    )
    const result = await builder.build(
      { title: `${title} for the hall`, cells },
      this.household?.storehouse
    )
    if (this.gatherer?.lastStock) this.household?.noteStock(this.gatherer.lastStock)
    if (work === 'chest' && result.missing === 0 && cells[0]) {
      this.household?.setStorehouse(cells[0], this.cfg.name)
      this.log.info(`the new chest at ${cells[0].x},${cells[0].y},${cells[0].z} is the storehouse`)
    }
    if (result.cancelled) return result.placed > 0
    // The court's own work says nothing when nothing came of it: it would be every minute.
    if (!royal && result.placed === 0) return false
    const short = Object.entries(result.short)
      .map(([block, n]) => `${n} ${block.replace(/_/g, ' ')}`)
      .join(', ')
    if (result.placed === 0 && result.missing > 0) {
      await this.speak(
        `You could not make ${title} for the hall at all${short ? `: there is no ${short} to be had` : ''}. ` +
          `Tell ${who} so honestly in one short sentence${short ? ', and that the storehouse or Merlin could help' : ''}.`,
        `Alas, I could not make ${title} for the hall${short ? `: I have no ${short}` : ''}.`
      )
    } else if (result.missing === 0) {
      await this.speak(
        `You have finished ${title} for the hall, by hand (${result.placed} blocks). Tell ${who} ` +
          'so in one short, proud sentence.',
        `${title[0].toUpperCase()}${title.slice(1)} for the hall is done!`
      )
    } else {
      await this.speak(
        `You made part of ${title} for the hall (${result.placed} blocks); ${result.missing} are ` +
          `still missing${short ? ` for want of ${short}` : ''}. Tell ${who} so honestly in one ` +
          'short sentence.',
        `I made part of it, but ${result.missing} blocks are still missing.`
      )
    }
    return result.placed > 0
  }

  /**
   * Hunt for the court's food (the King's rule: never a named or tame animal; see hunting.ts) and
   * bring the spoils to the storehouse. Returns how much meat it brought.
   */
  async startHunt(animals: number): Promise<number> {
    const hunter = this.hunter
    const chest = this.household?.storehouse
    if (!hunter || !chest || this.gathering || !byHand(this.gameMode())) return 0
    this.gathering = true
    this.pauseWorks()
    this.dutyFollowing = false
    this.movement?.stop()
    try {
      const result = await hunter.hunt(animals)
      if (result.killed === 0) return 0
      await this.gatherer?.withChest(chest, async (window) => {
        for (const item of this.body?.inventory.items() ?? [])
          if (SPOILS.test(item.name)) await window.deposit(item.type, item.metadata, item.count)
        return 0
      })
      if (this.gatherer?.lastStock) this.household?.noteStock(this.gatherer.lastStock)
      return result.meat
    } catch (err) {
      this.log.warn(`hunting failed: ${errMsg(err)}`)
      return 0
    } finally {
      this.gathering = false
    }
  }

  /**
   * Lay out the court's wheat field near home (once: flat untouched soil, by water if there is
   * any, clear of the hall) and tend it: till, plant, harvest, bake, store.
   */
  async startFarming(): Promise<boolean> {
    const farmer = this.farmer
    const body = this.body
    const home = this.household?.home
    if (!farmer || !body || !home || this.gathering || !byHand(this.gameMode())) return false
    let farm = this.household?.farm
    if (!farm) {
      const names = (x: number, y: number, z: number) => body.blockAt(new WorldVec(x, y, z))?.name
      const hall = this.household?.hall
      farm = chooseFarm(names, home, {
        keepClear: hall ? [...hall.ring, ...hall.inside] : [[home.x, home.z]],
      })
      if (!farm) {
        this.log.info('found no flat, untouched soil near home for a field')
        return false
      }
      this.household?.setFarm(farm)
      this.log.info(
        `laid out a wheat field at ${farm.cells[0].join(',')} (${farm.watered ? 'by water' : 'dry'})`
      )
    }
    this.gathering = true
    this.pauseWorks()
    this.dutyFollowing = false
    this.movement?.stop()
    try {
      const done = await farmer.tend(farm, this.household?.storehouse)
      if (this.gatherer?.lastStock) this.household?.noteStock(this.gatherer.lastStock)
      return done.harvested + done.tilled + done.planted + done.bread > 0
    } catch (err) {
      this.log.warn(`farming failed: ${errMsg(err)}`)
      return false
    } finally {
      this.gathering = false
    }
  }

  /**
   * Dig the court's mine on (a staircase near home, chosen once) for cobblestone and ore: a
   * pickaxe and wood from the storehouse, the stone and ore back into it, and the pickaxe too.
   */
  async startMining(want: number): Promise<number> {
    const miner = this.miner
    const body = this.body
    const home = this.household?.home
    const chest = this.household?.storehouse
    if (!miner || !body || !home || !chest || this.gathering || !byHand(this.gameMode())) return 0
    let mine = this.household?.mine
    if (!mine) {
      const names = (x: number, y: number, z: number) => body.blockAt(new WorldVec(x, y, z))?.name
      const hall = this.household?.hall
      const clear: Array<[number, number]> = [
        ...(hall ? [...hall.ring, ...hall.inside] : [[home.x, home.z] as [number, number]]),
        ...(this.household?.farm?.cells ?? []),
      ]
      mine = chooseMine(names, home, clear)
      if (!mine) {
        this.log.info('found no place near home to start a mine')
        return 0
      }
      this.household?.setMine(mine)
      this.log.info(`started the court's mine at ${mine.x},${mine.y},${mine.z}`)
    }
    this.gathering = true
    this.pauseWorks()
    this.dutyFollowing = false
    this.movement?.stop()
    const gatherer = this.gatherer
    try {
      // A pickaxe, sticks, some wood (for a pickaxe and a crafting table) and torches.
      await gatherer?.withChest(chest, async (window) => {
        for (const item of window.containerItems()) {
          const n = /_pickaxe$|^torch$|^stick$/.test(item.name)
            ? item.count
            : /_log$/.test(item.name) && this.carries(/_log$|_planks$/) < 4
              ? Math.min(3, item.count)
              : 0
          if (n > 0) await withTimeout(window.withdraw(item.type, item.metadata, n), 5_000)
        }
        return 0
      })
      const result = await miner.dig(mine, want)
      this.household?.setMine(mine)
      await gatherer?.withChest(chest, async (window) => {
        for (const item of this.body?.inventory.items() ?? [])
          if (
            /^(cobblestone|cobbled_deepslate|coal|raw_iron|raw_copper|dirt|andesite|diorite|granite)$|_pickaxe$/.test(
              item.name
            )
          )
            await withTimeout(window.deposit(item.type, item.metadata, item.count), 5_000)
        return 0
      })
      if (gatherer?.lastStock) this.household?.noteStock(gatherer.lastStock)
      if (result.ended) this.log.info(`the court's mine is done: ${result.ended}`)
      return result.cobblestone + result.ores
    } catch (err) {
      this.log.warn(`mining failed: ${errMsg(err)}`)
      return 0
    } finally {
      this.gathering = false
    }
  }

  /** A guard makes himself a sword: stone with cobblestone from the storehouse, else wood. */
  async startArming(): Promise<void> {
    const chest = this.household?.storehouse
    const body = this.body
    if (!chest || !body || this.gathering || this.carries(/_(sword|axe)$/) > 0) return
    this.gathering = true
    try {
      await this.gatherer?.withChest(chest, async (window) => {
        const take = async (items: RegExp, n: number) => {
          for (const item of window.containerItems().filter((i) => items.test(i.name))) {
            if (n <= 0) return
            const k = Math.min(n, item.count)
            await withTimeout(window.withdraw(item.type, item.metadata, k), 5_000)
            n -= k
          }
        }
        await take(/^cobblestone$/, 2)
        await take(/^stick$/, 1)
        // Wood for a stick, a wooden blade without cobblestone, and a crafting table.
        await take(/_log$/, 2)
        return 0
      })
      const log = this.log.child('arms')
      if (this.carries(/^stick$/) < 1) {
        await makePlanks(body, log, 2)
        await craft(body, log, 'stick', 1)
      }
      const sword = this.carries(/^cobblestone$/) >= 2 ? 'stone_sword' : 'wooden_sword'
      if (sword === 'wooden_sword') await makePlanks(body, log, 2)
      if (await craft(body, log, sword, 1))
        this.log.info(`made myself a ${sword.replace('_', ' ')}`)
    } catch (err) {
      this.log.warn(`arming failed: ${errMsg(err)}`)
    } finally {
      this.gathering = false
    }
  }

  /** Make charcoal in the hall's furnace from the storehouse's logs (for torches). */
  startCharcoal(): Promise<number> {
    return this.atFurnace((cook, furnace, chest) => cook.charcoal(furnace, chest))
  }

  /** Cook the storehouse's raw meat in the hall's furnace. Returns how much it cooked. */
  startCooking(): Promise<number> {
    return this.atFurnace((cook, furnace, chest) => cook.cook(furnace, chest))
  }

  /** Furnace work: find the hall's furnace, and do it there (busy meanwhile). */
  private async atFurnace(
    work: (
      cook: Cook,
      furnace: WorldVec,
      chest: { x: number; y: number; z: number }
    ) => Promise<number>
  ): Promise<number> {
    const cook = this.cook
    const body = this.body
    const chest = this.household?.storehouse
    const home = this.household?.home
    if (!cook || !body || !chest || !home || this.gathering) return 0
    const furnace = body.findBlocks({
      matching: (b: { name: string }) => /^(furnace|lit_furnace)$/.test(b.name),
      point: new WorldVec(home.x, home.y, home.z),
      maxDistance: 16,
      count: 1,
    })[0]
    if (!furnace) return 0
    this.gathering = true
    this.pauseWorks()
    this.dutyFollowing = false
    this.movement?.stop()
    try {
      const made = await work(cook, furnace, chest)
      if (this.gatherer?.lastStock) this.household?.noteStock(this.gatherer.lastStock)
      return made
    } catch (err) {
      this.log.warn(`furnace work failed: ${errMsg(err)}`)
      return 0
    } finally {
      this.gathering = false
    }
  }

  /** The chest closest to the royal (within 6 blocks) becomes the storehouse. */
  private async chooseStorehouse(requestedBy: string): Promise<void> {
    const body = this.body
    const near = this.playerPosition(requestedBy)
    if (!body || !near) return
    const found = body.findBlocks({
      matching: (b: { name: string }) => /^(chest|trapped_chest|barrel)$/.test(b.name),
      point: new WorldVec(near.x, near.y, near.z),
      maxDistance: 6,
      count: 1,
    })[0]
    const member = this.court?.find(requestedBy)
    const who = member ? `the ${member.title}` : requestedBy
    if (!found) {
      await this.speak(
        `${who} wants a chest to be the storehouse, but you see no chest near them. Ask kindly in ` +
          'one short sentence for a chest to be placed, then to say it again beside it.',
        'I see no chest here: place one, and tell me again beside it!'
      )
      return
    }
    this.emit('storehouse', { requestedBy, at: { x: found.x, y: found.y, z: found.z } })
  }

  /** Walk to a spot (home) if nothing else is going on. */
  goTo(spot: Point, label: string): void {
    this.movement?.goTo(spot, label)
  }

  /** A guard of the royal family (duty: escort). */
  isGuard(): boolean {
    return this.cfg.duty?.kind === 'escort'
  }

  /** How many matching items this bot carries. */
  carries(items: RegExp): number {
    return (
      this.body?.inventory
        .items()
        .filter((i) => items.test(i.name))
        .reduce((n, i) => n + i.count, 0) ?? 0
    )
  }

  /** Magic left this hour (Merlin); 0 for the others. */
  magicLeft(): number {
    return this.magic?.magicLeft() ?? 0
  }

  /** A block state property at a spot (a crop's growth), as this bot sees it. */
  blockProperty(x: number, y: number, z: number, name: string): unknown {
    const block = this.body?.blockAt(new WorldVec(x, y, z))
    return (block?.getProperties?.() as Record<string, unknown> | undefined)?.[name]
  }

  /** The name of the block at a spot as this bot sees it; undefined where nothing is loaded. */
  nameAt(x: number, y: number, z: number): string | undefined {
    return this.body?.blockAt(new WorldVec(x, y, z))?.name
  }

  /** Whether the server lets this bot's magic work right now. */
  magicAwake(): boolean {
    return this.magic?.available === true
  }

  /** A royal wants something else: put down the work order for a while. */
  private pauseWorks(): void {
    this.mason?.cancel()
    this.worksPausedUntil = Date.now() + DUTY_PAUSE_MS
  }

  /**
   * Raise a blueprint near a player (or near `place.at`) by creative flight, then tell the brain
   * how it went. It goes wherever a royal asks: the site is always free ground, and nothing
   * anyone made is ever broken. A build of the same thing left unfinished close by is finished
   * instead of started again.
   */
  async startBuild(
    blueprintId: BlueprintId,
    palette: Palette,
    requestedBy: string,
    place?: { at: Point; exact?: boolean }
  ): Promise<BuildOutcome> {
    const bp = makeBlueprint(blueprintId, palette)
    const outcome = (reason: BuildOutcome['reason']): BuildOutcome => ({
      title: bp.title,
      requestedBy,
      ok: false,
      placed: 0,
      total: bp.cells.length,
      reason,
    })
    const mason = this.mason
    if (!mason || this.state.status !== 'spawned') return outcome('busy')
    if (this.building) return this.reportBuild(outcome('busy'))
    this.building = true
    try {
      // Let go of any work order first (the mason stops at its next block).
      await this.letGo(mason)
      const near = place?.at ?? this.playerPosition(requestedBy)
      if (!near) return await this.reportBuild(outcome('not_visible'))
      this.movement?.stop()
      this.dutyFollowing = false
      // Handed on from afar: fly over first, so the ground there is loaded.
      const me = this.position()
      if (!me || Math.hypot(me.x - near.x, me.z - near.z) > 16) await mason.visit(near)
      // Still too far to see the ground there: that is no reason to say there is none.
      const ground = mason.world().kind(Math.floor(near.x), Math.floor(near.y), Math.floor(near.z))
      if (ground === undefined) return await this.reportBuild(outcome('unreachable'))
      const unfinished = this.buildLog.unfinished(this.cfg.name, blueprintId)
      const resume =
        unfinished && Math.hypot(unfinished.origin.x - near.x, unfinished.origin.z - near.z) < 32
          ? unfinished
          : undefined
      const avoid = Object.entries(this.body?.players ?? {})
        .filter(([name]) => name !== this.username)
        .map(([, p]) => p.entity?.position)
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({ x: p.x, y: p.y, z: p.z }))
      const site = resume
        ? resumeSite(resume)
        : findSite(bp, mason.world(), {
            near,
            faceToward: place?.exact ? undefined : near,
            avoid,
            minDistance: place?.exact ? -1 : 2,
          })
      if (!site) return await this.reportBuild(outcome('no_site'))
      const result = await this.raise(site, {
        title: bp.title,
        blueprint: blueprintId,
        palette: resume?.palette ?? palette,
        requestedBy,
        resume,
      })
      return await this.reportBuild(result)
    } finally {
      this.building = false
    }
  }

  /** Place a blueprint at its site with the mason, recording which blocks are ours (for undo). */
  private async raise(
    site: Site,
    opts: {
      title: string
      blueprint: BlueprintId
      palette: Palette
      requestedBy: string
      resume?: BuildRecord
    }
  ): Promise<BuildOutcome> {
    const mason = this.mason
    const { origin } = site
    const cells: PlanCell[] = [
      ...site.fill.map((p) => ({ ...p, block: opts.palette.primary })),
      ...site.blueprint.cells.map((c) => ({
        x: origin.x + c.x,
        y: origin.y + c.y,
        z: origin.z + c.z,
        block: c.block,
      })),
    ]
    const { title, requestedBy } = opts
    if (!mason)
      return { title, requestedBy, ok: false, placed: 0, total: cells.length, reason: 'cancelled' }
    const key = (p: Point) => `${p.x},${p.y},${p.z}`
    const stands = (c: PlanCell) => this.blockName(c) === c.block
    // What stands already was not placed now; on a resume, the build's blocks are ours anyway.
    const before = opts.resume ? new Set<string>() : new Set(cells.filter(stands).map(key))
    const record: BuildRecord = {
      id: opts.resume?.id ?? `${this.cfg.name}-${Date.now()}`,
      bot: this.cfg.name,
      blueprint: opts.blueprint,
      title,
      requestedBy,
      origin,
      quarterTurns: site.quarterTurns,
      palette: opts.palette,
      fill: site.fill,
      total: cells.length,
      complete: false,
      finishedAt: Date.now(),
      placed: opts.resume?.placed ?? [],
    }
    this.buildLog.upsert(record)
    this.log.info(
      `${opts.resume ? 'resuming' : 'building'} ${title} at ${origin.x},${origin.y},${origin.z}: ${cells.length} blocks`
    )
    const result = await mason.work({
      id: record.id,
      title,
      cells,
      columns: [],
      planned: new Map(cells.map((c) => [key(c), c.block])),
    })
    const known = new Set(record.placed.map(key))
    const placed = [
      ...record.placed,
      ...cells
        .filter((c) => !before.has(key(c)) && !known.has(key(c)) && stands(c))
        .map(({ x, y, z, block }) => ({ x, y, z, block })),
    ]
    const standing = cells.filter(stands).length
    const complete = !result.cancelled && standing === cells.length
    this.buildLog.upsert({ ...record, placed, complete, finishedAt: Date.now() })
    const ok = !result.cancelled && standing >= cells.length * 0.9
    return {
      title,
      requestedBy,
      ok,
      placed: standing,
      total: cells.length,
      reason: result.cancelled ? 'cancelled' : ok ? undefined : 'stuck',
    }
  }

  /** Tell the brain how a build went (it says so in chat); returns the outcome. */
  private async reportBuild(outcome: BuildOutcome): Promise<BuildOutcome> {
    try {
      const text = await this.brain.onBuildDone(outcome, this.context())
      if (text) this.chat(text)
    } catch (err) {
      this.log.warn(`brain.onBuildDone failed: ${errMsg(err)}`)
    }
    return outcome
  }

  /** Stop the mason's current job (it stops at its next block) and wait until it has. */
  private async letGo(mason: Mason): Promise<void> {
    mason.cancel()
    for (let i = 0; i < 50 && mason.busy; i++) await new Promise((r) => setTimeout(r, 200))
  }

  private blockName(p: Point): string | undefined {
    return this.body?.blockAt(new WorldVec(p.x, p.y, p.z))?.name
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
    if (this.building) return
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
    await this.startBuild(blueprintId, record.palette, requestedBy, { at: origin, exact: true })
  }

  /** Take down the last thing this bot built: only its own blocks, still as it left them. */
  async undoLastBuild(requestedBy: string): Promise<void> {
    const mason = this.mason
    if (!mason || this.building) return
    const last = this.buildLog.last(this.cfg.name)
    if (!last) return void this.log.info('nothing to take down')
    this.building = true
    try {
      await this.letGo(mason)
      this.movement?.stop()
      const me = this.position()
      if (!me || Math.hypot(me.x - last.origin.x, me.z - last.origin.z) > 16)
        await mason.visit(last.origin)
      if (last.placed.some((p) => this.blockName(p) === undefined)) {
        this.log.warn(`cannot see ${last.title} from here to take it down`)
        return
      }
      const ours = last.placed.filter((p) => this.blockName(p) === p.block)
      const result = await mason.work({
        id: `undo-${last.id}`,
        title: `taking down ${last.title}`,
        cells: ours.map(({ x, y, z }) => ({ x, y, z, block: 'air', remove: true })),
        columns: [],
        planned: new Map(),
      })
      if (result.cancelled) return
      this.buildLog.remove(last)
      const removed = ours.length - result.missing
      this.log.info(`took down ${last.title}: removed ${removed}/${last.placed.length}`)
      await this.reportBuild({
        title: last.title,
        requestedBy,
        undone: true,
        ok: true,
        placed: removed,
        total: removed,
      })
    } finally {
      this.building = false
    }
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
      gameMode: this.gameMode(),
      activity: this.mason?.activity() ?? this.movement?.describe() ?? undefined,
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
      const mode = this.gameMode()
      this.log.info(
        `spawned${this.state.position ? ` at ${fmtVec(this.state.position)}` : ''}${mode ? ` (${mode})` : ''}`
      )
      this.floor?.setOnline(this.cfg.name, true)
      this.emit('spawn')
      clearInterval(this.dutyTimer)
      this.dutyTimer = setInterval(() => this.tick(), 3_000)
      // A new session: the server forgets offline players' operator rights, so ask again.
      if (this.magic) {
        this.magic.available = undefined
        this.lastMagicCheck = Date.now() - 15_000
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
      this.mason?.cancel()
      this.mason = undefined
      // Errands and hand building die with the connection; the new body starts afresh.
      this.gatherer?.cancel()
      this.gatherer = undefined
      this.handbuilder?.cancel()
      this.handbuilder = undefined
      this.hunter?.cancel()
      this.hunter = undefined
      this.cook = undefined
      this.farmer = undefined
      this.miner?.cancel()
      this.miner = undefined
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
      // A royal lies down at night: the whole court goes to bed too, or the night cannot pass.
      if (
        event.notice?.key === 'chat.type.sleeping' &&
        this.court?.find(event.notice.params[0] ?? '')
      )
        void this.goToBed()
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
    // A royal speaking wakes the court up.
    if (this.body?.isSleeping && this.court?.find(event.from)) void this.body.wake().catch(() => {})
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
    if (event.kind !== 'whisper')
      this.log.debug(`the floor gives this line to ${responder ?? 'nobody'}`)
    const ctx = {
      ...this.context(),
      interim: (text: string) =>
        event.kind === 'whisper' ? this.whisper(event.from, text) : this.chat(text),
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
