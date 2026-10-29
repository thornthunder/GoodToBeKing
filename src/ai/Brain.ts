import type { SpellArgs } from '../magic/spells'
import type { Post } from './orders'
import type { BlueprintId, Palette } from '../build/blueprints'
import type { Material } from '../bot/gathering'

/** What the builders can do for the hall by hand. */
export type HallWork =
  | 'roof'
  | 'floor'
  | 'light'
  | 'door'
  | 'beds'
  | 'repair'
  | 'furnace'
  | 'chest'
  | 'reinforce'
  | 'table'
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
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'

/** Survival (or adventure): every block is gathered and laid by hand, no creative magic. */
export function byHand(mode: GameMode | undefined): boolean {
  return mode === 'survival' || mode === 'adventure'
}

export interface BrainContext {
  /** Say something before the answer is ready (to the speaker, the way the line came). */
  interim?: (text: string) => void
  botName: string
  /** The other players currently on the server (fellow bots excluded). */
  players: SeenPlayer[]
  position?: { x: number; y: number; z: number }
  /** The bot's game mode; undefined before the server said (taken as creative). */
  gameMode?: GameMode
  /** What the bot is doing, e.g. "following LittleOne42"; undefined when standing still. */
  activity?: string
  /** False when another bot of the court answers this line: listen, but stay quiet. */
  mayReply?: boolean
  /**
   * Whether the bot heard the line: whispered to it, its turn to answer, named in it, or said
   * within earshot. Only what a bot hears goes into its memory. Undefined means heard.
   */
  hears?: boolean
  /** The court's building works in progress, e.g. "the Great Castle (7 of 21 parts done)". */
  works?: string
}

/** Something the brain asks the bot's body to do. */
export type BotAction =
  | { type: 'follow' | 'come'; target: string }
  | { type: 'stop' }
  /** Stay where you are until released (a standing order). */
  | { type: 'stay' }
  /** Work Merlin's spells, in order (see magic/spells.ts). */
  | {
      type: 'cast'
      casts: Array<{ spell: string; args: SpellArgs; target: string }>
      requestedBy: string
    }
  /** Build it yourself, now. */
  | { type: 'build'; blueprint: BlueprintId; palette: Palette; requestedBy: string }
  /** Hand the build to a free builder of your staff (the Castellan's way). */
  | { type: 'commission'; blueprint: BlueprintId; palette: Palette; requestedBy: string }
  | { type: 'undo'; requestedBy: string }
  /** A royal orders great works: a new palace or castle, where they stand or at `at`. */
  | { type: 'works'; what: string; requestedBy: string; at?: { x: number; y?: number; z: number } }
  /**
   * Fetch a material by hand for a royal (survival); `delegate`: one of the staff goes;
   * `toStore`: it goes into the storehouse chest instead of to the royal.
   */
  | {
      type: 'gather'
      material: Material
      count: number
      requestedBy: string
      delegate?: boolean
      toStore?: boolean
    }
  /** Work on the court's home hall by hand (survival); `delegate`: a builder of the staff goes. */
  | { type: 'hallwork'; work: HallWork; requestedBy: string; delegate?: boolean }
  /** A royal makes the spot where they stand the court's home. */
  | { type: 'home'; requestedBy: string }
  /** A royal makes the chest beside them the court's storehouse. */
  | { type: 'storehouse'; requestedBy: string }

/** How a build went, for the brain to talk about. */
export interface BuildOutcome {
  title: string
  requestedBy: string
  ok: boolean
  placed: number
  total: number
  reason?: 'cancelled' | 'stuck' | 'no_site' | 'not_visible' | 'busy' | 'unreachable'
  /** The build was taken down again (undo), not raised. */
  undone?: boolean
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
  /** Called when a fellow bot of the court says something (never answered: only listened to). */
  onCourtLine?(event: ChatEvent, ctx: BrainContext): void
  /** Called when a player leaves the server. */
  onPlayerLeave?(player: string): void
  /** The standing order that keeps the body busy (following someone, staying put), if any. */
  post?(): Post | undefined
  /** What the bot still has to tell its superior, oldest first. */
  pendingReports?(): string[]
  /** The pending reports were given. */
  reported?(): void
  /** Called for translated server notices (deaths, sleeping, achievements, ...). */
  onNotice(event: ChatEvent, ctx: BrainContext): Promise<string | null>
  /** Called once when the bot cannot find a way to the player it is following or walking to. */
  onStuck(target: string, ctx: BrainContext): Promise<string | null>
  /** Called when a build (or taking one down) finishes or cannot start. */
  onBuildDone(outcome: BuildOutcome, ctx: BrainContext): Promise<string | null>
  /** Say something to the court about its own work, e.g. the Castellan handing out a task. */
  speak(instruction: string, ctx: BrainContext, fallback?: string): Promise<string | null>
}
