import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Playbook } from './playbook'
import { league, pairing, prepareCommands, type Score, type SideScore } from './referee'
import { WarBook } from './War'

/** Season 2 (the King's wish, 2026-11-04): three sides, two a round, White new. */
const SIDES = ['blue', 'green', 'white']

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the fixtures', () => {
  it('plays every pair in turn, each side two rounds in a row and then a rest', () => {
    expect([1, 2, 3].map((r) => pairing(SIDES, r))).toEqual([
      ['blue', 'green'],
      ['blue', 'white'],
      ['green', 'white'],
    ])
    // The next series begins again.
    expect(pairing(SIDES, 4)).toEqual(['blue', 'green'])
    // Two sides play every round.
    expect(pairing(['blue', 'green'], 2)).toEqual(['blue', 'green'])
    expect(() => pairing(['blue'], 1)).toThrow(/two sides/)
  })

  it('makes only the playing sides ready, and leaves the benched side alone', () => {
    const arena = {
      shared: true,
      bases: {
        blue: { home: { x: 0, y: 70, z: 0 } },
        green: { home: { x: 200, y: 70, z: 0 } },
        white: { home: { x: 100, y: 75, z: -170 } },
      },
      sides: { blue: ['Bram'], green: ['Gareth'], white: ['Walter'] },
    }
    const cmds = prepareCommands(arena, ['blue', 'white'])
    expect(cmds.filter((c) => c.startsWith('tp '))).toEqual([
      'tp Bram 0 70 0',
      'tp Walter 100 75 -170',
    ])
    expect(cmds.some((c) => c.includes('Gareth') || c.includes(' 200 '))).toBe(false)
    expect(cmds.filter((c) => c.endsWith(' chest'))).toHaveLength(2)
    // Without a list, every side (a two-sided season).
    expect(prepareCommands(arena).filter((c) => c.startsWith('tp '))).toHaveLength(3)
  })
})

describe('the league table', () => {
  const side = (s: string, brought: number, kills: number, deaths = 5): SideScore => ({
    side: s,
    brought,
    lost: 0,
    recovered: 0,
    kills,
    deaths,
    trips: brought ? 1 : 0,
  })
  const game = (winner: string | undefined, a: SideScore, b: SideScore): { score: Score } => ({
    score: { winner, decidedBy: winner ? 'items' : 'tie', sides: [a, b], why: '' },
  })

  it('counts games, items and kills for and against, most won first', () => {
    const table = league(
      [
        game('blue', side('blue', 100, 2), side('green', 20, 1)),
        game('white', side('blue', 0, 0), side('white', 50, 3, 9)),
        game(undefined, side('green', 0, 1), side('white', 0, 1)),
      ],
      SIDES
    )
    // Level on wins, the better item difference first.
    expect(table.map((s) => s.side)).toEqual(['white', 'blue', 'green'])
    const row = (side: string) => table.find((s) => s.side === side)
    expect(row('blue')).toEqual({
      side: 'blue',
      played: 2,
      won: 1,
      lost: 1,
      tied: 0,
      itemsFor: 100,
      itemsAgainst: 70,
      kills: 2,
      killed: 4,
      deaths: 10,
    })
    expect(row('white')).toMatchObject({ played: 2, won: 1, tied: 1, itemsFor: 50, deaths: 14 })
    expect(row('green')).toMatchObject({ played: 2, won: 0, lost: 1, tied: 1, itemsAgainst: 100 })
    // A side that has not played yet is in the table with nothing.
    expect(league([], SIDES).map((s) => s.played)).toEqual([0, 0, 0])
  })
})

describe('the bench', () => {
  it('keeps a side benched across a restart, and calls it in again', () => {
    const file = path.join(dir, 'war.json')
    const book = new WarBook(file, 'green')
    expect(book.benched).toBe(false)
    book.bench(true)
    book.bench(true)
    expect(new WarBook(file, 'green').benched).toBe(true)
    expect(book.data.events.filter((e) => e.kind === 'note')).toHaveLength(1)
    book.bench(false)
    expect(new WarBook(file, 'green').benched).toBe(false)
    expect(new WarBook(file, 'green').data.benched).toBeUndefined()
  })
})

describe('a playbook over two seasons', () => {
  it('says which season each line is from once it spans two, and keeps their rounds apart', () => {
    const book = new Playbook(path.join(dir, 'playbook.json'))
    book.learn({ series: 1, round: 1, result: 'won', text: 'blue brought 30' }, ['Rush early.'], 1)
    // Season 1's playbook reads as before.
    expect(book.forPlanning().lessons).toEqual(['(series 1, round 1) Rush early.'])
    book.learn(
      { season: 2, series: 1, round: 1, result: 'lost', text: 'white brought 12' },
      ['Guard the chest.'],
      2
    )
    const shown = book.forPlanning()
    expect(shown.lessons).toEqual([
      '(season 2, series 1, round 1) Guard the chest.',
      '(season 1, series 1, round 1) Rush early.',
    ])
    expect(shown.record).toEqual([
      'season 1, series 1, round 1: won; blue brought 30',
      'season 2, series 1, round 1: lost; white brought 12',
    ])
    // The same round of season 2 again replaces only itself.
    book.learn(
      { season: 2, series: 1, round: 1, result: 'lost', text: 'white brought 13' },
      ['Guard it better.'],
      3
    )
    expect(book.read().lessons.map((l) => l.text)).toEqual(['Rush early.', 'Guard it better.'])
    expect(book.read().rounds).toHaveLength(2)
  })
})
