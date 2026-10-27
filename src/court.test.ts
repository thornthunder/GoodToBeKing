import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CourtRoster, loadCourt, type CourtConfig } from './court'

const court: CourtConfig = {
  realm: 'Testland',
  charter: 'Serve the royal family.',
  members: [
    { player: 'LittleOne42', role: 'princess', title: 'Princess', address: 'Your Highness' },
    { player: 'BigDad', role: 'king', title: 'King', address: 'Your Majesty', notes: 'Rules all.' },
  ],
}

describe('CourtRoster', () => {
  const roster = new CourtRoster(court)

  it('finds members case-insensitively', () => {
    expect(roster.find('littleone42')?.title).toBe('Princess')
    expect(roster.find('Stranger')).toBeUndefined()
  })

  it('labels royals with their title', () => {
    expect(roster.label('BigDad')).toBe('BigDad (the King)')
    expect(roster.label('Stranger')).toBe('Stranger')
  })

  it('describes the court for prompts', () => {
    const text = roster.describe()
    expect(text).toContain('The royal court of Testland')
    expect(text).toContain('Serve the royal family.')
    expect(text).toContain('LittleOne42 is the Princess')
    expect(text).toContain('"Your Majesty"')
    expect(text).toContain('Rules all.')
  })

  it('describes nothing when the court is empty', () => {
    expect(new CourtRoster({ realm: 'x', charter: '', members: [] }).describe()).toBe('')
  })
})

describe('loadCourt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-'))

  it('returns an empty court when the file is missing', () => {
    const loaded = loadCourt(path.join(dir, 'missing.json'))
    expect(loaded.members).toEqual([])
    expect(loaded.file).toBeUndefined()
  })

  it('loads a valid file', () => {
    const file = path.join(dir, 'court.json')
    fs.writeFileSync(file, JSON.stringify(court))
    const loaded = loadCourt(file)
    expect(loaded.members).toHaveLength(2)
    expect(loaded.realm).toBe('Testland')
    expect(loaded.file).toBe(path.resolve(file))
  })

  it('rejects members with missing fields', () => {
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, JSON.stringify({ members: [{ player: 'x', role: 'king' }] }))
    expect(() => loadCourt(file)).toThrow(/members\[0\]/)
  })
})
