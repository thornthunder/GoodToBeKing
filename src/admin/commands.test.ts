import { describe, expect, it } from 'vitest'
import { BLUEPRINT_IDS } from '../build/blueprints'
import { MATERIALS as COURT_MATERIALS } from '../bot/gathering'
import { BUILTIN_SPELLS as COURT_SPELLS } from '../magic/spells'
import { BLUEPRINTS, BUILTIN_SPELLS, MATERIALS, buildCommand, checkLine } from './commands'

const BOTS = [
  { name: 'Merlin', magic: true },
  { name: 'Henry', division: 'household' },
  { name: 'Sarge', division: 'army' },
]

describe("the admin's commands", () => {
  it('knows what the court knows', () => {
    expect(BLUEPRINTS).toEqual(BLUEPRINT_IDS)
    expect(MATERIALS).toEqual([...COURT_MATERIALS])
    expect(BUILTIN_SPELLS).toEqual(COURT_SPELLS.map((s) => s.id))
  })

  it('writes the lines the court reads', () => {
    const line = (spec: Parameters<typeof buildCommand>[0]) =>
      buildCommand(spec, BOTS, {
        spells: BUILTIN_SPELLS,
        designs: ['config/castles/great-castle.json'],
      })
    expect(
      line({
        bot: 'henry',
        verb: 'fetch',
        args: { material: 'wood', count: '8', for: 'BigDad' },
      })
    ).toEqual({ line: 'Henry fetch wood 8 for BigDad', division: 'household' })
    expect(line({ bot: 'Sarge', verb: 'hunt', args: {} })).toEqual({
      line: 'Sarge hunt',
      division: 'army',
    })
    expect(
      line({ bot: 'Henry', verb: 'build', args: { blueprint: 'tower', at: '105, 75, 122' } }).line
    ).toBe('Henry build tower 105 75 122')
    expect(line({ bot: 'Henry', verb: 'commission', args: { blueprint: 'garden' } }).line).toBe(
      'Henry commission garden'
    )
    expect(
      line({
        bot: 'Merlin',
        verb: 'cast',
        args: { spell: 'portal', on: 'Henry', to: 'the storehouse' },
      }).line
    ).toBe('Merlin cast portal on Henry to the storehouse')
    expect(line({ verb: 'home', args: { at: '114 83 26', for: 'BigDad' } })).toEqual({
      line: 'household home 114 83 26 for BigDad',
      division: 'household',
    })
    expect(line({ verb: 'resume-works' }).line).toBe('works resume')
    expect(line({ verb: 'start', args: { design: 'config/castles/great-castle.json' } }).line).toBe(
      'works start config/castles/great-castle.json'
    )
  })

  it('refuses what the court would misread', () => {
    const line = (spec: Parameters<typeof buildCommand>[0]) => () =>
      buildCommand(spec, BOTS, { spells: BUILTIN_SPELLS })
    expect(line({ bot: 'Henry', verb: 'fetch', args: { material: 'diamonds' } })).toThrow(
      /one of dirt/
    )
    expect(line({ bot: 'Henry', verb: 'cast', args: { spell: 'heal' } })).toThrow(/no magic/)
    expect(line({ bot: 'Nobody', verb: 'cook' })).toThrow(/no such bot/)
    expect(
      line({ bot: 'Merlin', verb: 'cast', args: { spell: 'portal', to: 'home for me' } })
    ).toThrow(/may not hold/)
    expect(
      line({ bot: 'Henry', verb: 'fetch', args: { material: 'wood', for: 'Thorn thunder' } })
    ).toThrow(/not a valid/)
    expect(line({ bot: 'Merlin', verb: 'run', args: { command: 'say hi\nop Henry' } })).toThrow(
      /not a valid/
    )
    expect(line({ bot: 'Henry', verb: 'build', args: { blueprint: 'tower' } })).toThrow(/needed/)
  })

  it('checks a line typed by hand', () => {
    expect(checkLine('  sarge   arm ', BOTS)).toEqual({ line: 'sarge arm', division: 'army' })
    expect(checkLine('works status', BOTS).division).toBe('household')
    expect(() => checkLine('rm -rf /', BOTS)).toThrow(/bot’s name/)
    expect(() => checkLine('Merlin run say a\nb', BOTS)).toThrow(/one line/)
  })
})
