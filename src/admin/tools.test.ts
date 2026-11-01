import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOLS, toolArgs } from './tools'

const CHOICES = {
  designs: ['config/castles/great-castle.json'],
  bots: ['Henry'],
  blueprints: ['tower'],
}
const tool = (id: string) => TOOLS.find((t) => t.id === id)!

describe("the admin's tools", () => {
  it('runs only scripts that are there', () => {
    for (const t of TOOLS)
      expect(fs.existsSync(path.resolve(__dirname, '../../scripts', t.script)), t.script).toBe(true)
  })

  it('gives each script its arguments in order, checked', () => {
    expect(
      toolArgs(tool('survey-terrain'), { x1: '90', z1: '10', x2: '130', z2: '40' }, CHOICES)
    ).toEqual(['90', '10', '130', '40'])
    expect(
      toolArgs(
        tool('say-as'),
        { player: 'BigDad', lines: ['Merlin, hello', 'GMH'] },
        CHOICES
      )
    ).toEqual(['BigDad', 'Merlin, hello', 'GMH'])
    expect(
      toolArgs(tool('check-section'), { design: 'config/castles/great-castle.json' }, CHOICES)
    ).toEqual(['config/castles/great-castle.json'])
  })

  it('refuses what is not for it', () => {
    expect(() =>
      toolArgs(tool('survey-terrain'), { x1: '90', z1: '10', x2: '130' }, CHOICES)
    ).toThrow(/needed/)
    expect(() => toolArgs(tool('plan-castle'), { design: '../../etc/passwd' }, CHOICES)).toThrow(
      /not a valid/
    )
    expect(() =>
      toolArgs(tool('plan-castle'), { design: 'config/castles/other.json' }, CHOICES)
    ).toThrow(/no such design/)
    expect(() => toolArgs(tool('say-as'), { player: 'Thorn; rm', lines: ['hi'] }, CHOICES)).toThrow(
      /not a valid/
    )
    expect(() =>
      toolArgs(
        tool('survey-build'),
        { blueprint: 'tower', x: '1', y: '2', z: '3', turns: '1' },
        CHOICES
      )
    ).not.toThrow()
    expect(() =>
      toolArgs(
        tool('overlord-plan'),
        { terrain: '.state/../.env', out: '.state/designs/a.json' },
        CHOICES
      )
    ).toThrow(/not a valid/)
  })
})
