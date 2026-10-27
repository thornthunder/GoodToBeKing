import type { BlueprintId, Palette } from '../build/blueprints'
export type ChatKind = 'chat' | 'whisper' | 'announcement' | 'system'

/** One line of in-game chat, already normalised from the wire format. */
export interface ChatEvent {
  /** Player name, or "server" for system lines. */
  from: string
  message: string
  kind: ChatKind
  receivedAt: number
  /** For translated server notices: the language key and its (translated) parameters. */
  notice?: { key: string; params: string[] }
}

/** Another player as the bot currently sees them. */
export interface SeenPlayer {
  name: string
  /** Distance in blocks, when both positions are known. */
  distance?: number
}

/** Snapshot of what the bot knows about the world when the brain is consulted. */
export interface BrainContext {
  botName: string
  /** The other players currently on the server (fellow bots excluded). */
  players: SeenPlayer[]
  position?: { x: number; y: number; z: number }
  /** What the bot is doing, e.g. "following LittleOne42"; undefined when standing still. */
  activity?: string
  /** False when another bot of the court answers this line: listen, but stay quiet. */
  mayReply?: boolean
  /** The court's building works in progress, e.g. "the Great Castle (7 of 21 parts done)". */
  works?: string
}

/** Something the brain asks the bot's body to do. */
export type BotAction =
  | { type: 'follow' | 'come'; target: string }
  | { type: 'stop' }
  | { type: 'build'; blueprint: BlueprintId; palette: Palette; requestedBy: string }
  | { type: 'undo'; requestedBy: string }

/** How a build went, for the brain to talk about. */
export interface BuildOutcome {
  title: string
  requestedBy: string
  ok: boolean
  placed: number
  total: number
  reason?: 'cancelled' | 'stuck' | 'no_site' | 'outside_zone' | 'no_zone' | 'not_visible' | 'busy'
}

/** A reply to chat: words to say and/or an action to take. */
export interface BrainReply {
  say: string | null
  action?: BotAction
}

/**
 * The decision-making half of a bot. The Bot owns the connection and feeds the brain
 * events; the brain only answers with text to say (or null to stay silent).
 */
export interface Brain {
  /** Called once each time the bot spawns into the world. */
  onSpawn(ctx: BrainContext): Promise<string | null>
  /** Called when another (non-bot) player joins the server after the bot has spawned. */
  onPlayerJoin(player: string, ctx: BrainContext): Promise<string | null>
  /** Called for every player chat line the bot did not author itself. */
  onChat(event: ChatEvent, ctx: BrainContext): Promise<BrainReply | null>
  /** Called for translated server notices (deaths, sleeping, achievements, ...). */
  onNotice(event: ChatEvent, ctx: BrainContext): Promise<string | null>
  /** Called once when the bot cannot find a way to the player it is following or walking to. */
  onStuck(target: string, ctx: BrainContext): Promise<string | null>
  /** Called when a build (or taking one down) finishes or cannot start. */
  onBuildDone(outcome: BuildOutcome, ctx: BrainContext): Promise<string | null>
  /** Say something to the court about its own work, e.g. the Castellan handing out a task. */
  speak(instruction: string, ctx: BrainContext, fallback?: string): Promise<string | null>
}
