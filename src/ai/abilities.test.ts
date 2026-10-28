import { describe, expect, it } from 'vitest'
import {
  declineLine,
  detectMissingAbility,
  detectMoveCommand,
  detectWorksRequest,
  promisesAction,
} from './abilities'

describe('detectMoveCommand', () => {
  it.each([
    ['Merlin this is your princess commanding you to follow me', 'follow'],
    ['Merlin follow me', 'follow'],
    ['can you come with me to the castle', 'follow'],
    ['come here merlin', 'come'],
    ['Merlin come and see my house', 'come'],
    ['over here Merlin!', 'come'],
  ])('%s -> %s', (message, command) => {
    expect(detectMoveCommand(message, false)).toBe(command)
  })

  it('ignores chat that is not a movement request', () => {
    for (const message of ['hello Merlin', 'come on Merlin you can do it', 'I built a house']) {
      expect(detectMoveCommand(message, false)).toBeNull()
    }
  })

  it('only understands stop and wait while moving', () => {
    expect(detectMoveCommand('stop', true)).toBe('stop')
    expect(detectMoveCommand('wait here Merlin', true)).toBe('stop')
    expect(detectMoveCommand('stop', false)).toBeNull()
  })

  it('treats a negated request as stop, never as follow', () => {
    expect(detectMoveCommand("don't follow me", true)).toBe('stop')
    expect(detectMoveCommand('stop following me Merlin', true)).toBe('stop')
    expect(detectMoveCommand("don't follow me", false)).toBeNull()
  })
})

describe('detectMissingAbility', () => {
  it.each([
    ['can you build me a castle merlin', 'build'],
    ['make me a house please', 'build'],
    ['bring me a diamond', 'fetch'],
    ['Merlin go to the castle', 'travel'],
    ['teleport to me', 'travel'],
  ])('%s -> %s', (message, ability) => {
    expect(detectMissingAbility(message)).toBe(ability)
  })

  it.each([
    'hello Merlin',
    'Merlin give me your coordinates',
    'follow me',
    'I built a house today',
  ])('ignores "%s"', (message) => {
    expect(detectMissingAbility(message)).toBeNull()
  })
})

describe('promisesAction', () => {
  it.each([
    "I'm on my way to the castle, Your Highness!",
    'I will build you the finest castle in the realm.',
    'Let me fetch it for you at once.',
  ])('catches "%s"', (reply) => {
    expect(promisesAction(reply)).toBe(true)
  })

  it.each([
    'Alas, my building magic is still slumbering.',
    'Your Highness, I cannot build yet, my magic is not ready.',
    'Your Highness, I am at x 128, y 72, z 99.',
    'Shall we tell a story instead?',
    'I shall follow you, Your Highness!',
  ])('lets "%s" through', (reply) => {
    expect(promisesAction(reply)).toBe(false)
  })
})

describe('detectWorksRequest', () => {
  it('knows a palace or a new castle from the small builds', () => {
    expect(detectWorksRequest('Festaris, please build us a palace right here')).toEqual({
      what: 'palace',
    })
    expect(detectWorksRequest('build another castle at 120 70 -340')).toEqual({
      what: 'castle',
      at: { x: 120, y: 70, z: -340 },
    })
    expect(detectWorksRequest('make a fortress near x 50 z 60')).toEqual({
      what: 'fortress',
      at: { x: 50, z: 60 },
    })
    // A castle from the book, and talk about palaces, are not great works.
    expect(detectWorksRequest('build me a castle')).toBeNull()
    expect(detectWorksRequest('the palace is lovely')).toBeNull()
  })
})

describe('declineLine', () => {
  it('uses the form of address and makes no promise', () => {
    for (const ability of ['build', 'fetch', 'travel'] as const) {
      for (const magic of [true, false]) {
        const line = declineLine(ability, 'Your Highness', magic)
        expect(line).toContain('Your Highness')
        expect(promisesAction(line)).toBe(false)
      }
    }
    // Only the wizard has a spellbook.
    expect(declineLine('build', 'Your Highness')).not.toContain('spellbook')
  })
})
