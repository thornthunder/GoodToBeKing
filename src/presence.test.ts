import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AWAY_MS, Presence, worldWords } from './presence'

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'presence-')), 'presence.json')

describe('Presence', () => {
  it('keeps the court at home until the King calls it, and both worlds see it', () => {
    const f = file()
    const dev = new Presence(f, 'dev', 'dev')
    const creative = new Presence(f, 'creative', 'dev')
    expect(dev.courtHere()).toBe(true)
    expect(creative.courtHere()).toBe(false)
    creative.callHere('King', 1_000)
    expect(creative.courtHere()).toBe(true)
    expect(dev.world).toBe('creative')
    expect(dev.calledBy).toEqual({ by: 'King', at: 1_000 })
  })

  it('sends the court home a day after the King was last in the other world', () => {
    const f = file()
    const creative = new Presence(f, 'creative', 'dev')
    creative.callHere('King', 0)
    creative.noteKing(10 * 60_000)
    expect(creative.returnIfForgotten(10 * 60_000 + AWAY_MS - 1)).toBe(false)
    expect(creative.returnIfForgotten(10 * 60_000 + AWAY_MS)).toBe(true)
    expect(new Presence(f, 'dev', 'dev').courtHere()).toBe(true)
    // At home it never "returns".
    expect(new Presence(f, 'dev', 'dev').returnIfForgotten(10 * AWAY_MS)).toBe(false)
  })

  it('names worlds as the family does', () => {
    expect(worldWords('dev')).toBe('the Dev world')
  })
})
