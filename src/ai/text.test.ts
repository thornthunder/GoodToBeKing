import { describe, expect, it } from 'vitest'
import {
  cleanChatReply,
  levenshtein,
  mentionsName,
  mentionsNameLoosely,
  splitChatMessage,
  stripThinking,
} from './text'

describe('stripThinking', () => {
  it('removes closed think blocks', () => {
    expect(stripThinking('<think>hmm</think>Hello there')).toBe('Hello there')
  })
  it('removes an unterminated think block', () => {
    expect(stripThinking('Hi <think>still going')).toBe('Hi')
  })
})

describe('cleanChatReply', () => {
  it('strips markdown, quotes and a name prefix', () => {
    expect(cleanChatReply('"**KingBot:** Greetings, *subject*!"', 'KingBot')).toBe(
      'Greetings, subject!'
    )
  })
  it('strips an angle-bracket name prefix', () => {
    expect(cleanChatReply('<KingBot> hello', 'KingBot')).toBe('hello')
  })
  it('strips an echoed speaker label from the known list', () => {
    expect(cleanChatReply('Princess: Your Highness, hello!', 'Merlin', ['Princess'])).toBe(
      'Your Highness, hello!'
    )
    expect(
      cleanChatReply('LittleOne42 (the Princess): hi', 'Merlin', ['LittleOne42', 'Princess'])
    ).toBe('hi')
  })
  it('keeps a leading word that is not a known label', () => {
    expect(cleanChatReply('Indeed: the stars agree.', 'Merlin', ['Princess'])).toBe(
      'Indeed: the stars agree.'
    )
  })
  it('collapses whitespace', () => {
    expect(cleanChatReply('one\n\ntwo   three', 'X')).toBe('one two three')
  })
})

describe('mentionsName', () => {
  it('matches whole words case-insensitively', () => {
    expect(mentionsName('hey kingbot, come here', 'KingBot')).toBe(true)
    expect(mentionsName('KingBot!', 'KingBot')).toBe(true)
  })
  it('does not match substrings of other words', () => {
    expect(mentionsName('kingbots are cool', 'KingBot')).toBe(false)
  })
})

describe('mentionsNameLoosely', () => {
  it.each(['a very kind Marlon you are', 'Merlyn come here', "is that Merlin's hat", 'hi merlin'])(
    'accepts "%s"',
    (message) => expect(mentionsNameLoosely(message, 'Merlin')).toBe(true)
  )
  it.each(['I love melons', 'my cat is named Mittens', 'more than that'])(
    'rejects "%s"',
    (message) => expect(mentionsNameLoosely(message, 'Merlin')).toBe(false)
  )
  it('forgives one slip in a short name, but not an everyday word', () => {
    expect(mentionsNameLoosely('Henri come here', 'Henry')).toBe(true)
    expect(mentionsNameLoosely('Festaris, build us a palace right here', 'Henry')).toBe(false)
    expect(mentionsNameLoosely('Festeris, are you there', 'Festaris')).toBe(true)
  })
  it('stays exact for short names', () => {
    expect(mentionsNameLoosely('hi bob', 'Bob')).toBe(true)
    expect(mentionsNameLoosely('hi rob', 'Bob')).toBe(false)
  })
})

describe('levenshtein', () => {
  it('counts edits', () => {
    expect(levenshtein('marlon', 'merlin')).toBe(2)
    expect(levenshtein('merlin', 'merlin')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
  })
})

describe('splitChatMessage', () => {
  it('returns short text untouched', () => {
    expect(splitChatMessage('short')).toEqual(['short'])
  })
  it('splits on sentence boundaries', () => {
    const a = 'A'.repeat(120) + '.'
    const b = 'B'.repeat(120) + '.'
    expect(splitChatMessage(`${a} ${b}`, 200, 2)).toEqual([a, b])
  })
  it('caps the number of parts', () => {
    const s = 'x'.repeat(150) + '.'
    const parts = splitChatMessage(`${s} ${s} ${s}`, 200, 2)
    expect(parts).toHaveLength(2)
    expect(parts[1].endsWith('…')).toBe(true)
  })
  it('hard-wraps an oversized sentence', () => {
    const words = Array(60).fill('word').join(' ')
    const parts = splitChatMessage(words, 100, 5)
    expect(parts.every((p) => p.length <= 100)).toBe(true)
    expect(parts.length).toBeGreaterThan(1)
  })
})

describe('cleanChatReply: what the model copied from the prompt', () => {
  it('drops an [event] tag and narration before the bot speaks', () => {
    expect(
      cleanChatReply('[event] Bruce has died. Bruce: I am back. I will serve soon.', 'Bruce')
    ).toBe('I am back. I will serve soon.')
    expect(cleanChatReply('[court] All is well, Your Majesty.', 'Festaris')).toBe(
      'All is well, Your Majesty.'
    )
  })
})
