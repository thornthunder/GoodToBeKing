import { describe, expect, it } from 'vitest'
import { RIDDLES, guessedRiddle, pickRiddle, wantsRiddle } from './riddles'

describe('wantsRiddle', () => {
  it.each([
    "I don't know any others do you I'd like to hear one of yours riddle",
    'tell me a riddle Merlin',
    'another one!',
    'ask me one',
    'I would like to hear one of your riddles',
  ])('detects "%s"', (message) => expect(wantsRiddle(message, undefined)).toBe(true))

  it('takes a yes right after the bot offered a riddle', () => {
    expect(wantsRiddle('yes please', 'Shall I tell you a riddle?')).toBe(true)
    expect(wantsRiddle('yes please', 'Do you like your new house?')).toBe(false)
  })

  it('ignores ordinary chat', () => {
    expect(wantsRiddle('I built a house', undefined)).toBe(false)
  })
})

describe('guessedRiddle', () => {
  const piano = RIDDLES.find((r) => r.answer === 'a piano')!
  it('accepts the answer inside a sentence', () => {
    expect(guessedRiddle('is it a PIANO?', piano)).toBe(true)
  })
  it('rejects a wrong guess', () => {
    expect(guessedRiddle('is it a door', piano)).toBe(false)
  })
})

describe('pickRiddle', () => {
  it('does not repeat until the book is used up', () => {
    const told = new Set<string>()
    const seen = new Set<string>()
    for (let i = 0; i < RIDDLES.length; i++) {
      const r = pickRiddle(told)
      told.add(r.question)
      seen.add(r.question)
    }
    expect(seen.size).toBe(RIDDLES.length)
    expect(pickRiddle(told)).toBeDefined()
  })

  it('has no riddle about real-world personal details', () => {
    expect(RIDDLES.some((r) => /\bage\b|birthday|school/i.test(r.answer))).toBe(false)
  })
})
