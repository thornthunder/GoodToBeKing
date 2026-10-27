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

export function normalisePlayerList(
  packet: PlayerListPacket
): Array<{ type: string; record: PlayerRecord }> {
  const raw = packet.records
  if (Array.isArray(raw)) {
    return raw.map((record) => ({ type: record.type ?? 'add', record }))
  }
  return (raw.records ?? []).map((record) => ({ type: raw.type, record }))
}
