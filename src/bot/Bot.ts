import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Client } from 'bedrock-protocol'
import { createBot, type Bot as MineflayerBot, type BotOptions } from 'mineflayer-bedrock'
import type { BotAction, Brain, BrainContext } from '../ai/Brain'
import { splitChatMessage } from '../ai/text'
import type { BotConfig } from '../config'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { useLanguage } from './language'
import { Movement } from './movement'
import { loadSkin } from './skin'
import {
  buildTextPacket,
  normalisePlayerList,
  parseTextPacket,
  type AddPlayerPacket,
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
  private stopping = false
  private reconnectAttempts = 0
  private reconnectTimer?: NodeJS.Timeout
  /** Lower-cased names of all bots run by this app; they never greet or count each other. */
  private readonly botNames: Set<string>

  constructor(
    readonly cfg: BotConfig,
    private readonly brain: Brain,
    private readonly log: Logger,
    fellowBots: string[] = []
  ) {
    super()
    this.botNames = new Set([cfg.name, ...fellowBots].map((n) => n.toLowerCase()))
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
    // Device-code sign-in needs a human, so give online mode far longer.
    const spawnTimeoutMs = auth.offline ? 30_000 : 300_000

    this.state.status = 'connecting'
    this.log.info(
      `connecting to ${server.host}:${server.port} as ${this.cfg.name} ` +
        `(${auth.offline ? 'offline' : 'microsoft'} auth` +
        `${server.version ? `, version ${server.version}` : ''})`
    )

    const options: BotOptions = {
      host: server.host,
      port: server.port,
      username: this.cfg.name,
      auth: auth.offline ? 'offline' : 'microsoft',
      offline: auth.offline,
      profilesFolder: auth.profilesFolder,
      ...(server.version ? { version: server.version } : {}),
      ...(server.raknetBackend ? { raknetBackend: server.raknetBackend } : {}),
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
    if (action.type === 'stop') {
      movement.stop()
      return
    }
    const result =
      action.type === 'follow' ? movement.follow(action.target) : movement.comeTo(action.target)
    if (result !== 'ok') this.log.warn(`cannot ${action.type} ${action.target}: ${result}`)
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

  /** Run a slash command (e.g. "/tell Steve hi"). Field layout verified against 1.26.x only. */
  runCommand(command: string): void {
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
        uuid: randomUUID(),
        request_id: '',
        ...(modern ? { player_entity_id: 0n } : {}),
      },
      internal: false,
      version: modern ? 'latest' : 1,
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
      activity: this.movement?.describe() ?? undefined,
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
      this.emit('spawn')
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
          if (gone && !this.isBot(gone.name)) this.log.info(`${gone.name} left`)
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
      if (event.notice && this.state.status === 'spawned') {
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

    this.brain
      .onChat(event, this.context())
      .then((reply) => {
        if (reply?.say) this.chat(reply.say)
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
