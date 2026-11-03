import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  councilLine,
  councilWords,
  defaultCouncil,
  parseCouncil,
  type CouncilBrief,
} from './council'
import { lessonsBrief } from './lessons'
import { byValue } from './raiding'
import { metalPoints, metalWords, objectiveOf, scoreMetals } from './referee'
import { WarBook, type WarState } from './War'

const BLUE = ['Bram', 'Baldwin', 'Bevis', 'Brock', 'Barnaby', 'Bertram']
const GREEN = ['Gareth', 'Gilbert', 'Godwin', 'Gregor', 'Gawain', 'Giles']
const SIDES = { blue: BLUE, green: GREEN }

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function state(side: string, extra: Partial<WarState> = {}): WarState {
  return {
    side,
    phase: 'ended',
    orderedAt: 1000,
    raiders: {},
    brought: {},
    lost: {},
    recovered: {},
    kills: 0,
    deaths: 0,
    done: true,
    events: [],
    objective: 'metals',
    ...extra,
  }
}

describe('the metals objective', () => {
  it('scores bars only: gold 100, iron 25, copper 10', () => {
    const chest = { gold_ingot: 2, iron_ingot: 6, copper_ingot: 11, raw_gold: 9, iron_sword: 1 }
    expect(metalPoints(chest)).toBe(200 + 150 + 110)
    expect(metalWords(chest)).toBe('2 gold, 6 iron, 11 copper (460 points)')
    expect(metalWords({ cobblestone: 64 })).toBe('no bars (0 points)')
  })

  it('applies from the series the arena says', () => {
    const arena = { metals: { fromSeries: 3, points: { gold_ingot: 100 } } }
    expect(objectiveOf(arena, 2)).toBe('raid')
    expect(objectiveOf(arena, 3)).toBe('metals')
    expect(objectiveOf({}, 3)).toBe('raid')
  })

  it('wins by the points in one’s own chest, then by kills', () => {
    const blue = state('blue', {
      events: [
        { at: 2000, kind: 'death', who: 'Gareth', by: 'Brock', text: 'death.attack.player' },
      ],
    })
    const green = state('green')
    const won = scoreMetals([blue, green], SIDES, {
      blue: { iron_ingot: 4 },
      green: { copper_ingot: 9 },
    })
    expect(won.winner).toBe('blue')
    expect(won.decidedBy).toBe('metals')
    expect(won.why).toBe(
      "blue has 4 iron (100 points) in its chest to green's 9 copper (90 points)"
    )
    expect(won.sides.find((s) => s.side === 'blue')?.points).toBe(100)
    // Equal points: the kills decide.
    const tied = scoreMetals([blue, green], SIDES, {
      blue: { iron_ingot: 2 },
      green: { copper_ingot: 5 },
    })
    expect(tied.winner).toBe('blue')
    expect(tied.decidedBy).toBe('kills')
    const even = scoreMetals([state('blue'), green], SIDES, { blue: {}, green: {} })
    expect(even.winner).toBeUndefined()
    expect(even.decidedBy).toBe('tie')
  })

  it('takes bars first, then the ore, then the rest as it lies', () => {
    const items = [
      { name: 'cobblestone' },
      { name: 'raw_iron' },
      { name: 'copper_ingot' },
      { name: 'bread' },
      { name: 'gold_ingot' },
      { name: 'iron_ingot' },
    ]
    expect(byValue(items).map((i) => i.name)).toEqual([
      'gold_ingot',
      'iron_ingot',
      'copper_ingot',
      'raw_iron',
      'cobblestone',
      'bread',
    ])
  })
})

describe('the council', () => {
  const names = BLUE
  it('reads the model: names checked, raiders out already left alone, nobody twice', () => {
    const c = parseCouncil(
      {
        raiders: ['brock', 'Barnaby', 'Stranger'],
        defenders: ['Bram', 'Brock', 'Bertram'],
        tactic: 'fight',
        trips: 9,
        arms: true,
        tools: 'yes',
        words: 'Go!',
        reason: 'Because.',
      },
      names,
      ['Barnaby']
    )!
    expect(c.raiders).toEqual(['Brock'])
    expect(c.defenders).toEqual(['Bram', 'Bertram'])
    expect(c.tactic).toBe('fight')
    expect(c.trips).toBe(5)
    expect(c.arms).toBe(true)
    // Only a true is a yes.
    expect(c.tools).toBe(false)
    expect(councilLine(c)).toBe(
      'raiders Brock (fight, 5 trip(s)); defenders Bram, Bertram; arms yes, tools no'
    )
    expect(parseCouncil('nonsense', names)).toBeUndefined()
    expect(parseCouncil({ raiders: [], defenders: [] }, names)?.raiders).toEqual([])
  })

  it('without the model: everyone works, one soldier guards, a pickaxe only for gold seen', () => {
    const c = defaultCouncil(names, ['Brock', 'Barnaby'], 0, ['Brock'])
    expect(c.raiders).toEqual([])
    expect(c.defenders).toEqual(['Barnaby'])
    expect(c.arms).toBe(false)
    expect(c.tools).toBe(false)
    expect(defaultCouncil(names, ['Brock'], 2).tools).toBe(true)
  })

  it('tells the captain the day, the chests, the mine and the side', () => {
    const brief: CouncilBrief = {
      side: 'Blue',
      captain: 'Bram',
      enemySide: 'Green',
      day: 10,
      days: 10,
      members: [
        { name: 'Bram', role: 'captain', health: 20, food: 20, home: true },
        { name: 'Brock', role: 'soldier', health: 12, food: 9, home: false, doing: 'raiding' },
      ],
      stock: { iron_ingot: 3, coal: 12 },
      home: { x: 0, y: 64, z: 0 },
      enemyChest: { x: 184, y: 64, z: 56 },
      night: true,
      enemySeen: { items: { gold_ingot: 1 }, minutesAgo: 7 },
      goldSeen: 2,
      ironPickaxe: false,
      onRaid: ['Brock'],
      recent: ['3 min: Brock took from their chest: 1 gold_ingot'],
      playbook: ['Guard the chest at night.'],
      record: [],
    }
    const words = councilWords(brief)
    expect(words).toContain('It is day 10 of 10 (the last); it is night now.')
    expect(words).toContain('Our chest holds 3 iron (75 points), and 12 coal.')
    expect(words).toContain('7 minutes ago their chest held 1 gold (100 points).')
    expect(words).toContain('192 blocks to the east')
    expect(words).toContain('no iron pickaxe; the miner saw 2 gold ore and had to leave it.')
    expect(words).toContain('Still out raiding: Brock.')
    expect(words).toContain('- Guard the chest at night.')
  })

  it('is recorded day by day, raiders keeping what they carry', () => {
    const book = new WarBook(path.join(dir, 'blue.json'), 'blue')
    book.order(
      { side: 'green', names: GREEN, chest: { x: 9, y: 64, z: 9 }, home: { x: 9, y: 64, z: 12 } },
      1000,
      'metals'
    )
    book.grab('Brock', { gold_ingot: 1 }, 2000)
    book.raiderDone('Brock', '1 trip(s) done', 2500)
    const c = defaultCouncil(BLUE, ['Brock'], 0)
    book.council({ ...c, raiders: ['Brock'] }, 2, 'raiders Brock', 3000)
    expect(book.data.objective).toBe('metals')
    expect(book.data.raiders.Brock.carrying).toEqual({ gold_ingot: 1 })
    expect(book.data.raiders.Brock.done).toBeUndefined()
    expect(book.data.councils).toBe(1)
    book.count({ iron_ingot: 2 }, '2 iron (50 points)', 4000)
    expect(book.data.counted).toEqual({ items: { iron_ingot: 2 }, at: 4000 })
    expect(book.data.events.at(-1)?.text).toBe('our chest counted: 2 iron (50 points)')
  })
})

describe('the lessons of a metals round', () => {
  it('show both chests, both sides’ councils and deaths in sum, not one by one', () => {
    const blue = state('blue', {
      enemy: {
        side: 'green',
        names: GREEN,
        chest: { x: 1, y: 1, z: 1 },
        home: { x: 1, y: 1, z: 1 },
      },
      events: [
        { at: 2000, kind: 'plan', text: 'day 1: no raid; defenders Bram' },
        { at: 3000, kind: 'death', who: 'Brock', by: 'Gareth', text: 'death.attack.player' },
        { at: 4000, kind: 'death', who: 'Bevis', text: 'death.attack.explosion.player' },
      ],
    })
    const green = state('green', {
      enemy: { side: 'blue', names: BLUE, chest: { x: 1, y: 1, z: 1 }, home: { x: 1, y: 1, z: 1 } },
      events: [{ at: 2000, kind: 'plan', text: 'day 1: raiders Gawain (rush, 2 trip(s))' }],
    })
    const chests = { blue: { iron_ingot: 2 }, green: { gold_ingot: 1 } }
    const result = scoreMetals([blue, green], SIDES, chests)
    const brief = lessonsBrief({
      series: 3,
      round: 1,
      state: blue,
      other: green,
      score: result,
      objective: 'metals',
      chests: { mine: chests.blue, theirs: chests.green },
      playbook: [],
    })
    expect(brief).toContain('your side (blue) lost')
    expect(brief).toContain(
      'Your chest at the count: 2 iron (50 points). Theirs (green): 1 gold (100 points).'
    )
    expect(brief).toContain(
      "died 2 times, 1 of them at the other side's hands (1 by Gareth, 1 by explosion)"
    )
    expect(brief).toContain('the plan: day 1: no raid; defenders Bram')
    expect(brief).toContain('the plan: day 1: raiders Gawain (rush, 2 trip(s))')
    expect(brief).not.toContain('Brock died')
  })
})
