import { describe, expect, it } from 'vitest'
import {
  buildTextPacket,
  fixOutgoing,
  metadataTarget,
  normalisePlayerList,
  parseTextPacket,
  playerSpawn,
  stripFormatting,
} from './packets'

describe('playerSpawn', () => {
  const none = { x: -2147483648, y: -2147483648, z: -2147483648 }
  it('reads the bed a player respawns at, none, or nothing about the player', () => {
    // As the Dev world sent it (2026-10-31): at login with no bed, then after a tap.
    expect(
      playerSpawn({
        spawn_type: 'player',
        player_position: none,
        dimension: 3,
        world_position: none,
      })
    ).toBeNull()
    expect(
      playerSpawn({
        spawn_type: 'player',
        player_position: { x: 101, y: 69, z: 22 },
        dimension: 0,
        world_position: { x: 99, y: 69, z: 22 },
      })
    ).toEqual({ x: 101, y: 69, z: 22 })
    expect(
      playerSpawn({
        spawn_type: 'world',
        player_position: { x: 0, y: 64, z: 0 },
        dimension: 0,
        world_position: { x: 0, y: 64, z: 0 },
      })
    ).toBeUndefined()
  })
})

describe('stripFormatting', () => {
  it('removes section-sign colour codes', () => {
    expect(stripFormatting('§aGreen§r text')).toBe('Green text')
  })
})

describe('parseTextPacket', () => {
  it('maps player chat', () => {
    const ev = parseTextPacket({
      type: 'chat',
      needs_translation: false,
      source_name: 'Steve',
      message: 'hello KingBot',
    })
    expect(ev).toMatchObject({ from: 'Steve', message: 'hello KingBot', kind: 'chat' })
  })

  it('maps translated chat.type.text', () => {
    const ev = parseTextPacket({
      type: 'translation',
      needs_translation: true,
      message: 'chat.type.text',
      parameters: ['<Alex>', 'hi there'],
    })
    expect(ev).toMatchObject({ from: 'Alex', message: 'hi there', kind: 'chat' })
  })

  it('turns join translations into system lines', () => {
    const ev = parseTextPacket({
      type: 'translation',
      needs_translation: true,
      message: '§e%multiplayer.player.joined',
      parameters: ['Alex'],
    })
    expect(ev).toMatchObject({ from: 'server', message: 'Alex joined the game', kind: 'system' })
  })

  it('fills positional translation parameters', () => {
    const ev = parseTextPacket({
      type: 'translation',
      needs_translation: true,
      message: '%1$s was slain by %2$s',
      parameters: ['Steve', 'a Zombie'],
    })
    expect(ev?.message).toBe('Steve was slain by a Zombie')
  })

  it('translates language keys, including keys inside parameters', () => {
    const ev = parseTextPacket({
      type: 'translation',
      needs_translation: true,
      message: 'death.attack.mob',
      parameters: ['Alex', '%entity.zombie.name'],
    })
    expect(ev).toMatchObject({
      message: 'Alex was slain by Zombie',
      notice: { key: 'death.attack.mob', params: ['Alex', 'Zombie'] },
    })
  })

  it('translates the sleeping notice', () => {
    const ev = parseTextPacket({
      type: 'translation',
      needs_translation: true,
      message: 'chat.type.sleeping',
      parameters: ['Alex', '1'],
    })
    expect(ev?.message).toBe(
      'Alex is sleeping in a bed. To skip to dawn, 1 more users need to sleep in beds at the same time.'
    )
    expect(ev?.notice?.key).toBe('chat.type.sleeping')
  })

  it('keeps an unknown key readable', () => {
    const ev = parseTextPacket({
      type: 'translation',
      needs_translation: true,
      message: 'no.such.key',
      parameters: [],
    })
    expect(ev?.message).toBe('no.such.key')
  })

  it('ignores json packets', () => {
    expect(parseTextPacket({ type: 'json', needs_translation: false, message: '{}' })).toBeNull()
  })
})

describe('buildTextPacket', () => {
  it('produces a complete chat packet', () => {
    expect(buildTextPacket('chat', 'KingBot', 'hi')).toMatchObject({
      type: 'chat',
      category: 'authored',
      source_name: 'KingBot',
      message: 'hi',
      has_filtered_message: false,
    })
  })
})

describe('normalisePlayerList', () => {
  it('handles the flat 1.26 layout', () => {
    const out = normalisePlayerList({
      records: [
        { type: 'add', uuid: 'a', username: 'Alex' },
        { type: 'remove', uuid: 'b' },
      ],
    })
    expect(out).toEqual([
      { type: 'add', record: { type: 'add', uuid: 'a', username: 'Alex' } },
      { type: 'remove', record: { type: 'remove', uuid: 'b' } },
    ])
  })

  it('handles the legacy nested layout', () => {
    const out = normalisePlayerList({
      records: { type: 'add', records: [{ uuid: 'a', username: 'Alex' }] },
    })
    expect(out).toEqual([{ type: 'add', record: { uuid: 'a', username: 'Alex' } }])
  })
})

describe('metadataTarget', () => {
  const varint = (n: bigint) => {
    const out: number[] = []
    do {
      const low = Number(n & 0x7fn)
      n >>= 7n
      out.push(n ? low | 0x80 : low)
    } while (n)
    return out
  }
  const packet = (id: number, entity: bigint) =>
    Buffer.from([...varint(BigInt(id)), ...varint(entity), 0, 0, 0])

  it('reads the entity of a set_entity_data packet without decoding it', () => {
    expect(metadataTarget(packet(39, 7833n))).toBe(7833n)
    expect(metadataTarget(packet(39, 2n ** 40n + 5n))).toBe(2n ** 40n + 5n)
  })

  it('leaves every other packet alone', () => {
    expect(metadataTarget(packet(111, 7833n))).toBeUndefined()
    expect(metadataTarget(packet(39 + 128, 1n))).toBeUndefined()
    expect(metadataTarget(Buffer.from([39]))).toBeUndefined()
  })
})

describe('fixOutgoing (Bedrock 1.26.60 item stack actions)', () => {
  it('moves the legacy bytes that craft_reserved pushed up, and leaves the rest', () => {
    const craft = {
      requests: [
        {
          actions: [
            { type_id: 'craft_recipe', legacy_type_id: 12 },
            { type_id: 'results_deprecated', legacy_type_id: 19 },
            { type_id: 'take', legacy_type_id: 0 },
          ],
        },
      ],
    }
    fixOutgoing('item_stack_request', craft)
    expect(craft.requests[0].actions.map((a) => a.legacy_type_id)).toEqual([12, 20, 0])
    const input = {
      item_stack_request: { actions: [{ type_id: 'non_implemented', legacy_type_id: 18 }] },
    }
    fixOutgoing('player_auth_input', input)
    expect(input.item_stack_request.actions[0].legacy_type_id).toBe(19)
  })
})
