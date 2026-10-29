import type { ChatEvent } from '../ai/Brain'
import { translate, translateParam } from './language'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** `text` packet as emitted by bedrock-protocol (fields vary by `type`). */
export interface TextPacket {
  type: string
  needs_translation: boolean
  category?: string
  source_name?: string
  message: string
  parameters?: string[]
  xuid?: string
  platform_chat_id?: string
}

export interface StartGamePacket {
  entity_id: bigint
  runtime_entity_id: bigint
  player_position: Vec3
  world_name?: string
  player_gamemode?: string
}

export interface MovePlayerPacket {
  runtime_id: number | bigint
  position: Vec3
  pitch: number
  yaw: number
  head_yaw: number
  mode: string
  on_ground: boolean
}

export interface SetHealthPacket {
  health: number
}

export interface AddPlayerPacket {
  uuid: string
  username: string
  runtime_id: bigint
  unique_id: bigint
  position: Vec3
}

/** A player (or entity) left render distance or the world. */
export interface RemoveEntityPacket {
  entity_id_self: bigint
}

/**
 * Sent during spawn and on respawn. state 0 = searching for spawn, 1 = ready to spawn
 * (position is the settled spawn point), 2 = client ready.
 */
export interface RespawnPacket {
  position: Vec3
  state: number
  runtime_entity_id: bigint
}

export interface PlayerRecord {
  type?: string
  uuid: string
  username?: string
  entity_unique_id?: bigint
}

/**
 * `player_list` changed shape in 1.26: it used to be `{ type, records: [...] }`,
 * now it is a flat array of records that each carry their own `type`.
 */
export interface PlayerListPacket {
  records: PlayerRecord[] | { type: string; records?: PlayerRecord[] }
}

/** The server's answer to a command_request (our own commands, matched by origin uuid). */
export interface CommandOutputPacket {
  origin: { type: string; uuid: string; request_id: string }
  output_type: string
  success_count: number
  output: Array<{ message_id: string; success: boolean; parameters: string[] }>
}

export interface DisconnectPacket {
  reason: string
  hide_disconnect_reason: boolean
  message?: string
}

/** Build an outgoing chat-style `text` packet for the current protocol. */
export function buildTextPacket(
  type: 'chat' | 'whisper' | 'announcement',
  sourceName: string,
  message: string
): Record<string, unknown> {
  return {
    type,
    needs_translation: false,
    category: 'authored',
    source_name: sourceName,
    message,
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: false,
    filtered_message: '',
  }
}

/** Strip Minecraft section-sign colour codes. */
export function stripFormatting(text: string): string {
  return text.replace(/§./g, '')
}

/** Normalise an incoming `text` packet into a ChatEvent, or null for packet types we ignore. */
export function parseTextPacket(packet: TextPacket): ChatEvent | null {
  const receivedAt = Date.now()
  const message = stripFormatting(packet.message ?? '')

  switch (packet.type) {
    case 'chat':
    case 'whisper':
    case 'announcement': {
      if (!packet.source_name) return null
      return { from: stripFormatting(packet.source_name), message, kind: packet.type, receivedAt }
    }
    case 'translation': {
      const params = (packet.parameters ?? []).map(stripFormatting)
      const key = message.replace(/^%/, '')
      if (key === 'chat.type.text' && params.length >= 2) {
        return {
          from: params[0].replace(/^<|>$/g, ''),
          message: params[1],
          kind: 'chat',
          receivedAt,
        }
      }
      return {
        from: 'server',
        message: translate(message, params),
        kind: 'system',
        receivedAt,
        notice: { key, params: params.map(translateParam) },
      }
    }
    case 'raw':
    case 'system':
    case 'tip':
    case 'popup':
    case 'jukebox_popup':
      return message ? { from: 'server', message, kind: 'system', receivedAt } : null
    default:
      return null
  }
}

/** Packet id of `set_entity_data` (1.26.x): the id varint, then `runtime_entity_id` (varint64). */
const SET_ENTITY_DATA = 39

/**
 * The entity a `set_entity_data` packet is about, read from its first bytes without decoding the
 * rest; undefined for any other packet.
 */
export function metadataTarget(packet: Buffer): bigint | undefined {
  let offset = 0
  let id = 0
  for (let shift = 0; ; shift += 7) {
    const byte = packet[offset++]
    if (byte === undefined || shift > 28) return undefined
    id |= (byte & 0x7f) << shift
    if (!(byte & 0x80)) break
  }
  if (id !== SET_ENTITY_DATA) return undefined
  let entity = 0n
  for (let shift = 0n; ; shift += 7n) {
    const byte = packet[offset++]
    if (byte === undefined || shift > 63n) return undefined
    entity |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return entity
  }
}

export function normalisePlayerList(
  packet: PlayerListPacket
): Array<{ type: string; record: PlayerRecord }> {
  const raw = packet.records
  if (Array.isArray(raw)) {
    return raw.map((record) => ({ type: record.type ?? 'add', record }))
  }
  return (raw.records ?? []).map((record) => ({ type: raw.type, record }))
}

/**
 * Bedrock 1.26.60 added the item stack action `craft_reserved`. BDS reads each action's body by
 * its `legacy_type_id` byte (the pre-1.26.40 numbering), and there it is 18, so `non_implemented`
 * and `results_deprecated` moved up to 19 and 20. bedboo, written for 1.26.51, still sends 18 and
 * 19: every craft (which ends with `results_deprecated`) then made the server drop the bot. Drop
 * this with the minecraft-data patch once bedboo supports the server's version.
 */
const LEGACY_ACTION_IDS_1_26_60: Record<string, number> = {
  craft_reserved: 18,
  non_implemented: 19,
  results_deprecated: 20,
}

interface StackRequestLike {
  actions?: Array<{ type_id?: string; legacy_type_id?: number }>
}

/** Correct an outgoing item stack request's legacy action bytes for 1.26.60, in place. */
export function fixStackRequest(request: StackRequestLike | undefined): void {
  for (const action of request?.actions ?? []) {
    const fixed = action.type_id ? LEGACY_ACTION_IDS_1_26_60[action.type_id] : undefined
    if (fixed !== undefined) action.legacy_type_id = fixed
  }
}

/** Correct any item stack requests in an outgoing packet (standalone, or inside player input). */
export function fixOutgoing(name: string, params: unknown): void {
  const p = params as { requests?: StackRequestLike[]; item_stack_request?: StackRequestLike }
  if (name === 'item_stack_request') for (const r of p.requests ?? []) fixStackRequest(r)
  else if (name === 'player_auth_input') fixStackRequest(p.item_stack_request)
}
