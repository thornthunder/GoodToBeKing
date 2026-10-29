import { describe, expect, it } from 'vitest'
import {
  declineLine,
  detectBuildRequest,
  detectGatherRequest,
  detectHomeRequest,
  detectStorehouseRequest,
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

describe('detectBuildRequest, asked the Castellan way', () => {
  it('hears "have it built" as a request, but not a question about who built something', () => {
    expect(detectBuildRequest('Festaris, please have a flower garden built for me here')).toEqual({
      blueprint: 'garden',
    })
    expect(detectBuildRequest("I'd like a tower built over there")).toEqual({ blueprint: 'tower' })
    expect(detectBuildRequest('who built this lovely tower?')).toBeNull()
    expect(detectMissingAbility('can you get a fountain built here')).toBe('build')
  })
})

describe('detectGatherRequest', () => {
  it('hears an errand, with how much is wanted', () => {
    expect(detectGatherRequest('Henry, fetch me 10 dirt')).toEqual({ material: 'dirt', count: 10 })
    expect(detectGatherRequest('chop some wood for us please')).toEqual({
      material: 'wood',
      count: 16,
    })
    expect(detectGatherRequest('get me a stack of sand')).toEqual({ material: 'sand', count: 64 })
    expect(detectGatherRequest('george could you collect twenty logs')).toEqual({
      material: 'wood',
      count: 20,
    })
    expect(detectGatherRequest('dig 200 dirt')).toEqual({ material: 'dirt', count: 64 })
  })

  it('leaves questions and other lines alone', () => {
    expect(detectGatherRequest('where can I get wood?')).toBeNull()
    expect(detectGatherRequest('Henry come here')).toBeNull()
    expect(detectGatherRequest('this dirt hall is lovely')).toBeNull()
  })
})

describe('the household', () => {
  it('hears a royal choosing the home', () => {
    expect(detectHomeRequest('Let us now make it our home')).toBe(true)
    expect(detectHomeRequest('this hall is our home now')).toBe(true)
    expect(detectHomeRequest('our home is here')).toBe(true)
    expect(detectHomeRequest('I miss my home')).toBe(false)
    expect(detectHomeRequest('go home Henry')).toBe(false)
  })

  it('hears a royal choosing the storehouse, but not an errand to it', () => {
    expect(detectStorehouseRequest('this chest is our storehouse')).toBe(true)
    expect(detectStorehouseRequest('use this chest for storage please')).toBe(true)
    expect(detectStorehouseRequest('put the dirt in the chest')).toBe(false)
    expect(detectGatherRequest('Henry, fetch 20 dirt for the storehouse')).toEqual({
      material: 'dirt',
      count: 20,
      toStore: true,
    })
  })
})

describe('declineLine in survival', () => {
  it('says the court cannot build by hand yet, offering no spellbook', () => {
    const line = declineLine('handbuild', 'Your Highness')
    expect(line).toContain('gathered and laid by hand')
    expect(line).not.toContain('garden')
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
