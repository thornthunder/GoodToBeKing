import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import type { SkinConfig } from './bot/skin'
import type { Zone } from './build/site'
import { loadCourt, type CourtConfig } from './court'
import { isLogLevel, type LogLevel } from './logger'

export interface ServerConfig {
  host: string
  port: number
  /** Explicit Bedrock version (e.g. "1.26.51"). Undefined = auto-detect from the server ping. */
  version?: string
  /** RakNet implementation: native C++ (default) or the pure-JS port. */
  raknetBackend?: RaknetBackend
  /**
   * How to reach the server: RakNet (the default) or Nethernet (WebRTC, with HTTP signalling on
   * the server port). Bedrock 1.26.60 servers answer only on Nethernet.
   */
  transport?: Transport
  /**
   * Nethernet's WebRTC: werift (pure JS, the default) or wrtc (native libwebrtc, needs the
   * optional @roamhq/wrtc package); auto = wrtc when installed. werift encrypts every packet on
   * the one JS thread: six bots kept it 94% busy, so flights and chat ran late.
   */
  webrtc?: WebrtcBackend
}

export type RaknetBackend = 'raknet-native' | 'jsp-raknet'
export type Transport = 'raknet' | 'nethernet'
export type WebrtcBackend = 'werift' | 'wrtc' | 'auto'

function envWebrtc(key: string): WebrtcBackend | undefined {
  const value = env(key)
  if (value === undefined) return undefined
  if (value === 'werift' || value === 'wrtc' || value === 'auto') return value
  throw new Error(`${key} must be werift, wrtc or auto, got "${value}"`)
}

function envTransport(key: string): Transport | undefined {
  const value = env(key)
  if (value === undefined) return undefined
  if (value === 'raknet' || value === 'nethernet') return value
  throw new Error(`${key} must be raknet or nethernet, got "${value}"`)
}

function envRaknetBackend(key: string): RaknetBackend | undefined {
  const value = env(key)
  if (value === undefined) return undefined
  if (value === 'raknet-native' || value === 'jsp-raknet') return value
  throw new Error(`${key} must be raknet-native or jsp-raknet, got "${value}"`)
}

export interface AuthConfig {
  /** true = no Microsoft/Xbox login (server must be online-mode=false). */
  offline: boolean
  /** Folder where Microsoft auth tokens are cached. */
  profilesFolder: string
}

export interface OllamaConfig {
  host: string
  model: string
  temperature: number
  timeoutMs: number
  keepAlive?: string
  numCtx?: number
  /** undefined = model default; false disables thinking on thinking-capable models. */
  think?: boolean
  /** Model for background memory extraction; can be bigger and slower than the chat model. */
  memoryModel?: string
  /** Model that reads royal lines for orders; undefined = the chat model. */
  orderModel?: string
}

export interface ChatConfig {
  /** Reply to every chat line instead of only when addressed by name or whispered. */
  respondToAll: boolean
  /** Reply to every chat line from a member of the royal court, even without a name mention. */
  respondToRoyals: boolean
  /** Welcome players who are not in the court when they join. Royals are always hailed. */
  greetVisitors: boolean
  /** Minimum gap between two replies. */
  cooldownMs: number
  /** Said once after spawning. */
  greeting?: string
  /** How many chat lines the bot remembers when prompting the model. */
  historySize: number
  /** Said at once when an answer for a royal takes a while ("Hmm, let me see..."). */
  thinking?: string[]
}

export interface BotConfig {
  name: string
  persona: string
  server: ServerConfig
  auth: AuthConfig
  ai: OllamaConfig
  chat: ChatConfig
  autoReconnect: boolean
  /** The bot's look; undefined = the default skin. */
  skin?: SkinConfig
  /** Where the bot may build; undefined = it does not build at all. */
  buildZone?: Zone
  /** The bot's place at court, e.g. "court wizard" or "royal guard". */
  role: string
  /**
   * The courtier this bot reports to and takes orders from; the royal family outranks everyone.
   * Undefined: it answers to the royal family alone.
   */
  reportsTo?: string
  /** Whether this bot builds from the spellbook (others suggest asking a builder). */
  canBuild: boolean
  /** A standing duty, e.g. escorting a royal (see Bot.performDuty). */
  duty?: Duty
  /** Takes part in the court's building works (the great castle). */
  works: boolean
  /** Works magic (Merlin): needs operator rights on the server, and cheats on. */
  magic?: boolean
}

/** "escort" = follow the first of `royals` who is online and in sight, unless told otherwise. */
export interface Duty {
  kind: 'escort'
  /** Court titles in order of preference, e.g. ["Princess", "King"]. */
  royals: string[]
}

export interface AppConfig {
  logLevel: LogLevel
  bots: BotConfig[]
  court: CourtConfig
  /** Castle design the court builds together (WORKS_DESIGN), e.g. config/castles/great-castle.json. */
  worksDesign?: string
}

export const DEFAULT_PERSONA =
  'You are Merlin, wizard of the royal court: wise, warm and a little mysterious, fond of riddles ' +
  'and harmless magic. You speak with gentle grandeur and look after everyone in the realm.'

function env(key: string): string | undefined {
  const value = process.env[key]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

function envStr(key: string, fallback: string): string {
  return env(key) ?? fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const value = env(key)
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function envNum(key: string, fallback: number): number {
  const value = env(key)
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${value}"`)
  return n
}

function envOptionalNum(key: string): number | undefined {
  return env(key) === undefined ? undefined : envNum(key, 0)
}

function envOptionalBool(key: string): boolean | undefined {
  return env(key) === undefined ? undefined : envBool(key, false)
}

/** "105,75,122" + radius -> a build zone; undefined when the centre is not set. */
function envZone(centerKey: string, radiusKey: string): Zone | undefined {
  const value = env(centerKey)
  if (value === undefined) return undefined
  const parts = value.split(/[\s,]+/).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${centerKey} must be "x,y,z", got "${value}"`)
  }
  const [x, y, z] = parts
  return { center: { x, y, z }, radius: envNum(radiusKey, 100) }
}

/** One bot built purely from environment variables (and .env). */
export function defaultBotConfig(): BotConfig {
  return {
    name: envStr('BOT_NAME', 'Merlin'),
    persona: envStr('BOT_PERSONA', DEFAULT_PERSONA),
    server: {
      host: envStr('MC_HOST', '127.0.0.1'),
      port: envNum('MC_PORT', 19132),
      version: env('MC_VERSION'),
      raknetBackend: envRaknetBackend('MC_RAKNET_BACKEND'),
      transport: envTransport('MC_TRANSPORT'),
      webrtc: envWebrtc('MC_WEBRTC'),
    },
    auth: {
      offline: envBool('MC_OFFLINE', true),
      profilesFolder: path.resolve(envStr('MC_PROFILES_FOLDER', '.auth-cache')),
    },
    ai: {
      host: envStr('OLLAMA_HOST', 'http://ava:11434'),
      model: envStr('OLLAMA_MODEL', 'gemma4:e4b'),
      temperature: envNum('OLLAMA_TEMPERATURE', 0.7),
      timeoutMs: envNum('OLLAMA_TIMEOUT_MS', 60_000),
      keepAlive: env('OLLAMA_KEEP_ALIVE') ?? '24h',
      numCtx: envOptionalNum('OLLAMA_NUM_CTX'),
      think: envOptionalBool('OLLAMA_THINK'),
      memoryModel: env('OLLAMA_MEMORY_MODEL'),
      orderModel: env('OLLAMA_ORDER_MODEL'),
    },
    chat: {
      respondToAll: envBool('BOT_RESPOND_TO_ALL', false),
      respondToRoyals: envBool('BOT_RESPOND_TO_ROYALS', true),
      greetVisitors: envBool('BOT_GREET_VISITORS', true),
      cooldownMs: envNum('BOT_CHAT_COOLDOWN_MS', 3_000),
      greeting: env('BOT_GREETING'),
      historySize: envNum('BOT_HISTORY_SIZE', 20),
    },
    autoReconnect: envBool('BOT_AUTO_RECONNECT', true),
    skin: env('BOT_SKIN')
      ? {
          texture: envStr('BOT_SKIN', ''),
          geometry: env('BOT_SKIN_GEOMETRY'),
          cape: env('BOT_CAPE'),
        }
      : undefined,
    buildZone: envZone('BUILD_CENTER', 'BUILD_RADIUS'),
    role: envStr('BOT_ROLE', 'court wizard'),
    canBuild: envBool('BOT_CAN_BUILD', true),
    works: envBool('BOT_WORKS', false),
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export type BotOverride = DeepPartial<BotConfig>

/**
 * Layer per-bot overrides on top of the environment defaults, one section at a time. The skin is
 * never inherited: every bot in a bots file names its own look (or wears the default skin).
 */
export function mergeBotConfig(base: BotConfig, override: BotOverride): BotConfig {
  return {
    ...base,
    ...override,
    server: { ...base.server, ...override.server },
    auth: { ...base.auth, ...override.auth },
    ai: { ...base.ai, ...override.ai },
    chat: { ...base.chat, ...override.chat },
    skin: override.skin?.texture ? (override.skin as SkinConfig) : undefined,
  } as BotConfig
}

export function loadConfig(): AppConfig {
  const base = defaultBotConfig()
  let bots: BotConfig[] = [base]

  const botsFile = env('BOTS_FILE')
  if (botsFile) {
    const file = path.resolve(botsFile)
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${file} must contain a non-empty JSON array of bot overrides`)
    }
    bots = parsed.map((override: BotOverride) => mergeBotConfig(base, override))
  }

  const names = new Set<string>()
  for (const bot of bots) {
    if (!bot.name) throw new Error('Every bot needs a name')
    if (names.has(bot.name)) throw new Error(`Duplicate bot name: ${bot.name}`)
    names.add(bot.name)
  }
  for (const bot of bots) {
    if (bot.reportsTo !== undefined && (!names.has(bot.reportsTo) || bot.reportsTo === bot.name))
      throw new Error(
        `${bot.name} reports to "${bot.reportsTo}", who is not another bot of the court`
      )
  }

  const logLevel = envStr('LOG_LEVEL', 'info').toLowerCase()
  if (!isLogLevel(logLevel))
    throw new Error(`LOG_LEVEL must be debug|info|warn|error, got "${logLevel}"`)

  const court = loadCourt(envStr('COURT_FILE', 'config/court.json'))
  const worksDesign = env('WORKS_DESIGN')

  return { logLevel, bots, court, ...(worksDesign ? { worksDesign } : {}) }
}
