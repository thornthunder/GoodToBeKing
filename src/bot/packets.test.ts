import { describe, expect, it } from 'vitest'
import { buildTextPacket, normalisePlayerList, parseTextPacket, stripFormatting } from './packets'

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
