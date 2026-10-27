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
}

/** Something the brain asks the bot's body to do. */
export type BotAction = { type: 'follow' | 'come'; target: string } | { type: 'stop' }

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
}
