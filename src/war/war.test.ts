import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { briefWords, defaultPlan, parsePlan, type Brief } from './plan'
import { Playbook } from './playbook'
import {
  chestOf,
  hallCommands,
  mergeDeaths,
  musterCommands,
  prepareCommands,
  resultOf,
  score,
  timeline,
  type Arena,
} from './referee'
import { grew, pockets, shrank } from './raiding'
import { botNames, sideTitle, warSide } from './side'
import { WarBook, readWar, total, type WarState } from './War'

const BLUE = ['Bram', 'Baldwin', 'Bevis', 'Brock', 'Barnaby', 'Bertram']
const GREEN = ['Gareth', 'Gilbert', 'Godwin', 'Gregor', 'Gawain', 'Giles']

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function book(side = 'blue'): WarBook {
  const b = new WarBook(path.join(dir, `${side}.json`), side)
  b.mine = new Set((side === 'blue' ? BLUE : GREEN).map((n) => n.toLowerCase()))
  return b
}

const enemyOf = (side: string) =>
  side === 'blue'
    ? {
        side: 'green',
        names: GREEN,
        chest: { x: 200, y: 70, z: -3 },
        home: { x: 200, y: 70, z: 0 },
      }
    : { side: 'blue', names: BLUE, chest: { x: 0, y: 70, z: -3 }, home: { x: 0, y: 70, z: 0 } }

describe('WarBook', () => {
  it('counts only what a raider took from their chest and put in ours', () => {
    const b = book()
    b.reset(1, 1)
    expect(b.phase).toBe('peace')
    b.order(enemyOf('blue'), 1000)
    b.setPlan(defaultPlan(BLUE, ['Brock', 'Barnaby', 'Bertram']))
    b.start()
    b.grab('Brock', { cobblestone: 20, bread: 4 })
    // It also had 3 bread of its own in its pockets: only the 4 taken count.
    const loot = b.deposit('Brock', { cobblestone: 20, bread: 7 })
    expect(loot).toEqual({ cobblestone: 20, bread: 4 })
    expect(b.data.brought).toEqual({ cobblestone: 20, bread: 4 })
    expect(total(b.data.brought)).toBe(24)
    expect(b.data.raiders.Brock.carrying).toEqual({})
  })

  it('loses what a dead raider carried, and finishes when every raider is done', () => {
    const b = book()
    b.order(enemyOf('blue'))
    b.setPlan(parsePlan({ raiders: ['Brock', 'Barnaby'], defenders: [] }, BLUE)!)
    b.grab('Brock', { dirt: 10 })
    expect(b.lost('Brock')).toEqual({ dirt: 10 })
    expect(b.data.lost).toEqual({ dirt: 10 })
    expect(b.lost('Brock')).toEqual({})
    b.raiderDone('Brock', 'their chest is empty')
    expect(b.data.done).toBe(false)
    b.raiderDone('Barnaby', '2 trip(s) done')
    expect(b.data.done).toBe(true)
    b.raiderDone('Barnaby', 'again')
    expect(b.data.events.filter((e) => e.kind === 'done')).toHaveLength(2)
  })

  it('counts a death once though every courtier heard it, and only during the raid', () => {
    const b = book()
    expect(b.death('Gregor', 'Brock', 'death.attack.player', 1000)).toBe(false)
    b.order(enemyOf('blue'), 2000)
    expect(b.death('Gregor', 'Brock', 'death.attack.player', 3000)).toBe(true)
    expect(b.death('Gregor', 'Brock', 'death.attack.player', 3500)).toBe(false)
    expect(b.death('Gregor', 'Brock', 'death.attack.player', 9000)).toBe(true)
    expect(b.death('Brock', 'Zombie', 'death.attack.mob', 4000)).toBe(true)
    expect(b.death('Surveyor', undefined, 'death.fell.accident.generic', 4000)).toBe(false)
    expect(b.data.kills).toBe(2)
    expect(b.data.deaths).toBe(1)
    b.end()
    expect(b.phase).toBe('ended')
    expect(b.data.done).toBe(true)
    expect(b.death('Giles', 'Brock', 'death.attack.player', 20000)).toBe(false)
  })

  it('is kept in its file and read back by the referee', () => {
    const b = book()
    b.reset(2, 3)
    b.order(enemyOf('blue'))
    b.grab('Brock', { oak_log: 5 })
    const again = new WarBook(path.join(dir, 'blue.json'), 'blue')
    expect(again.data.round).toBe(3)
    expect(again.data.raiders.Brock.carrying).toEqual({ oak_log: 5 })
    expect(readWar(path.join(dir, 'blue.json'))?.series).toBe(2)
    expect(readWar(path.join(dir, 'nothing.json'))).toBeUndefined()
  })
})

describe('the plan', () => {
  it("reads the model's answer, drops strangers and gives the rest the defence", () => {
    const plan = parsePlan(
      {
        raiders: ['brock', 'Barnaby', 'Gregor', 'Brock'],
        defenders: ['Bram', 'Barnaby'],
        tactic: 'fight',
        when: 'night',
        trips: 9,
        words: ' Onward! ',
        reason: 'They have no armour.',
      },
      BLUE
    )
    expect(plan).toEqual({
      raiders: ['Brock', 'Barnaby'],
      defenders: ['Bram', 'Baldwin', 'Bevis', 'Bertram'],
      tactic: 'fight',
      when: 'night',
      trips: 5,
      words: 'Onward!',
      reason: 'They have no armour.',
      by: 'model',
    })
  })

  it('wants at least one raider and falls back on sound choices', () => {
    expect(parsePlan({ raiders: [], defenders: BLUE }, BLUE)).toBeUndefined()
    expect(parsePlan('nonsense', BLUE)).toBeUndefined()
    const plan = parsePlan(
      { raiders: ['Bram'], tactic: 'sneak', when: 'dawn', trips: 'two' },
      BLUE
    )!
    expect(plan.tactic).toBe('rush')
    expect(plan.when).toBe('now')
    expect(plan.trips).toBe(1)
    expect(plan.words).toBeUndefined()
  })

  it('sends the soldiers by default, and half the side without any', () => {
    const plan = defaultPlan(BLUE, ['Brock', 'Barnaby', 'Bertram'])
    expect(plan.raiders).toEqual(['Brock', 'Barnaby', 'Bertram'])
    expect(plan.defenders).toEqual(['Bram', 'Baldwin', 'Bevis'])
    expect(plan.by).toBe('default')
    expect(defaultPlan(BLUE, []).raiders).toEqual(['Bram', 'Baldwin', 'Bevis'])
  })

  it('briefs the captain on the side, the enemy chest and the playbook', () => {
    const brief: Brief = {
      side: 'Blue',
      captain: 'Bram',
      enemySide: 'Green',
      members: [
        {
          name: 'Bram',
          role: 'captain',
          gear: { sword: 'stone', shield: false },
          health: 20,
          food: 18,
          home: true,
        },
        {
          name: 'Brock',
          role: 'soldier',
          gear: { sword: 'iron', head: 'iron', chest: 'copper', shield: true },
          health: 12,
          food: 9,
          home: false,
        },
        { name: 'Bevis', role: 'worker', home: true },
      ],
      stock: { cobblestone: 40, bread: 6, dirt: 100 },
      home: { x: 0, y: 70, z: 0 },
      enemyChest: { x: 200, y: 70, z: -3 },
      night: false,
      playbook: ['Send everyone: the defenders never saw a raider.'],
      record: ["series 1, round 1: lost; green brought 30 items home to blue's 0"],
    }
    const words = briefWords(brief)
    expect(words).toContain('Bram (you, the captain)')
    expect(words).toContain('iron sword, 2 piece(s) of iron armour, a shield')
    expect(words).toContain('out of sight')
    expect(words).toContain('146 items: 100 dirt, 40 cobblestone, 6 bread')
    expect(words).toContain('200 blocks to the east')
    expect(words).toContain('Send everyone')
    expect(words).toContain('round 1: lost')
    expect(briefWords({ ...brief, playbook: [], record: [] })).toContain('first round')
  })
})

describe('the referee', () => {
  const arena: Arena = {
    cycleMs: 1000,
    buildCycles: 1,
    raidCycles: 1,
    rounds: 3,
    series: 1,
    bases: { blue: { home: { x: 0, y: 70, z: 0 } }, green: { home: { x: 200, y: 70, z: 0 } } },
    sides: { blue: BLUE, green: GREEN },
  }

  it('makes a hall three high with a doorway south and a chest by the north wall', () => {
    const cmds = hallCommands(arena.bases.blue)
    expect(chestOf(arena.bases.blue)).toEqual({ x: 0, y: 70, z: -3 })
    expect(cmds).toContain('fill -4 70 -4 4 72 -4 cobblestone')
    expect(cmds).toContain('fill 0 70 4 0 71 4 air')
    expect(cmds).toContain('setblock 0 70 -3 chest')
    expect(cmds.indexOf('setblock 0 70 -3 air')).toBeLessThan(
      cmds.indexOf('setblock 0 70 -3 chest')
    )
    expect(cmds.find((c) => c.endsWith(' air') && c.startsWith('fill -5 70'))).toBe(
      'fill -5 70 -5 5 80 5 air'
    )
    expect(musterCommands(arena.bases.green, ['Gareth'])).toEqual([
      'clear Gareth',
      'tp Gareth 200 70 0',
      'spawnpoint Gareth 200 70 0',
    ])
    const all = prepareCommands(arena)
    expect(all[0]).toBe('time set 1000')
    expect(all.at(-1)).toBe('kill @e[type=item]')
    expect(all.filter((c) => c.startsWith('tp '))).toHaveLength(12)
  })

  function state(
    side: string,
    events: WarState['events'],
    extra: Partial<WarState> = {}
  ): WarState {
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
      events,
      ...extra,
    }
  }

  it('scores by items brought home, then by kills, and merges the deaths both sides heard', () => {
    const blue = state(
      'blue',
      [
        { at: 1000, kind: 'order' },
        { at: 61000, kind: 'grab', who: 'Brock', items: { dirt: 30 } },
        { at: 121000, kind: 'deposit', who: 'Brock', items: { dirt: 30 } },
        { at: 130000, kind: 'death', who: 'Gregor', by: 'Brock', text: 'death.attack.player' },
      ],
      { brought: { dirt: 30 }, plan: parsePlan({ raiders: ['Brock'] }, BLUE) }
    )
    const green = state(
      'green',
      [
        { at: 1000, kind: 'order' },
        { at: 131000, kind: 'death', who: 'Gregor', by: 'Brock', text: 'death.attack.player' },
        { at: 200000, kind: 'death', who: 'Bevis', by: 'Giles', text: 'death.attack.player.item' },
        { at: 201000, kind: 'grab', who: 'Giles', items: { dirt: 30 } },
        { at: 230000, kind: 'lost', who: 'Giles', items: { dirt: 30 } },
      ],
      { lost: { dirt: 30 } }
    )
    expect(mergeDeaths([blue, green])).toHaveLength(2)
    const s = score([blue, green], arena.sides)
    expect(s.winner).toBe('blue')
    expect(s.decidedBy).toBe('items')
    const b = s.sides.find((x) => x.side === 'blue')!
    const g = s.sides.find((x) => x.side === 'green')!
    expect(b).toMatchObject({
      brought: 30,
      kills: 1,
      deaths: 1,
      trips: 1,
      firstGrabMin: 1,
      firstDepositMin: 2,
    })
    expect(b.plan).toBe('rush, now, 1 trip(s); 1 raiders, 5 defenders')
    expect(g).toMatchObject({
      brought: 0,
      lost: 30,
      kills: 1,
      deaths: 1,
      trips: 0,
      firstDepositMin: undefined,
    })
    expect(resultOf(s, 'blue')).toBe('won')
    expect(resultOf(s, 'green')).toBe('lost')

    const tie = score([{ ...blue, brought: {} }, green], arena.sides)
    expect(tie.decidedBy).toBe('tie')
    expect(resultOf(tie, 'blue')).toBe('tie')
    const byKills = score(
      [
        {
          ...blue,
          brought: {},
          events: [
            ...blue.events,
            { at: 140000, kind: 'death', who: 'Giles', by: 'Bram', text: 'death.attack.player' },
          ],
        },
        green,
      ],
      arena.sides
    )
    expect(byKills.winner).toBe('blue')
    expect(byKills.decidedBy).toBe('kills')
  })

  it('tells the round as a side saw it, a line a minute', () => {
    const lines = timeline(
      state('blue', [
        { at: 1000, kind: 'order', text: 'raid the green chest at 200,70,-3' },
        { at: 31000, kind: 'plan', text: 'rush, now, 2 trip(s)' },
        { at: 61000, kind: 'grab', who: 'Brock', items: { dirt: 30, bread: 2 } },
        { at: 91000, kind: 'death', who: 'Brock', by: 'Giles', text: 'death.attack.player' },
        { at: 92000, kind: 'lost', who: 'Brock', items: { dirt: 30, bread: 2 } },
        { at: 400000, kind: 'done', who: 'Brock', text: 'their chest is empty' },
      ])
    )
    expect(lines).toEqual([
      '0 min: the order came: raid the green chest at 200,70,-3',
      '0.5 min: the plan: rush, now, 2 trip(s)',
      '1 min: Brock took from their chest: 30 dirt, 2 bread',
      '1.5 min: Brock died, killed by Giles (attack.player)',
      '1.5 min: Brock lost what it carried: 30 dirt, 2 bread',
      '6.7 min: Brock stopped: their chest is empty',
    ])
    const many = state(
      'blue',
      Array.from({ length: 100 }, (_, i) => ({
        at: 1000 + i * 1000,
        kind: 'note' as const,
        text: `n${i}`,
      }))
    )
    expect(timeline(many, 10)).toHaveLength(10)
    expect(timeline(many, 10).at(-1)).toBe('... and 91 more')
  })
})

describe('the playbook', () => {
  it("keeps each round's lessons once and shows the newest first", () => {
    const p = new Playbook(path.join(dir, 'playbook.json'))
    expect(p.forPlanning()).toEqual({ lessons: [], record: [] })
    p.learn({ series: 1, round: 1, result: 'lost', text: 'green brought 30' }, [
      'Send more raiders.',
    ])
    p.learn({ series: 1, round: 2, result: 'won', text: 'blue brought 40' }, [
      'Rush works.',
      'Hold the chest.',
    ])
    // Scored again (a restart): the round's old lessons go.
    p.learn({ series: 1, round: 2, result: 'won', text: 'blue brought 40' }, ['Rush works by day.'])
    const shown = p.forPlanning()
    expect(shown.lessons).toEqual([
      '(series 1, round 2) Rush works by day.',
      '(series 1, round 1) Send more raiders.',
    ])
    expect(shown.record).toEqual([
      'series 1, round 1: lost; green brought 30',
      'series 1, round 2: won; blue brought 40',
    ])
  })
})

describe('the sides', () => {
  it('knows its side and the enemy from the bots files', () => {
    expect(warSide({})).toBeUndefined()
    expect(() => warSide({ COURT_SIDE: 'red' })).toThrow(/blue or green/)
    const blue = warSide({ COURT_SIDE: 'Blue' })!
    expect(blue.name).toBe('blue')
    expect(blue.enemy.name).toBe('green')
    expect(blue.enemy.names).toEqual(GREEN)
    expect(warSide({ COURT_SIDE: 'green' })!.enemy.names).toEqual(BLUE)
    expect(botNames(path.resolve('config/war/blue.json'))).toEqual(BLUE)
    expect(sideTitle('green')).toBe('Green')
  })

  it('tells loot from gear in the pockets', () => {
    const items = [
      { name: 'iron_sword', count: 1 },
      { name: 'dirt', count: 30 },
      { name: 'dirt', count: 10 },
      { name: 'shield', count: 1 },
      { name: 'bread', count: 3 },
    ]
    const bot = { inventory: { items: () => items } } as unknown as Parameters<typeof pockets>[0]
    expect(pockets(bot)).toEqual({ dirt: 40, bread: 3 })
    expect(grew({ dirt: 40, bread: 3 }, { dirt: 45, bread: 3, oak_log: 2 })).toEqual({
      dirt: 5,
      oak_log: 2,
    })
    expect(shrank({ dirt: 40, bread: 3 }, { dirt: 10 })).toEqual({ dirt: 30, bread: 3 })
  })
})

describe('a shared world', () => {
  it('leaves the time, the weather and what lies about alone', () => {
    const arena: Arena = {
      cycleMs: 1,
      buildCycles: 1,
      raidCycles: 1,
      rounds: 1,
      series: 1,
      bases: { blue: { home: { x: 0, y: 70, z: 0 } }, green: { home: { x: 200, y: 70, z: 0 } } },
      sides: { blue: ['Bram'], green: ['Gareth'] },
      shared: true,
    }
    const cmds = prepareCommands(arena)
    expect(cmds.some((c) => /^(time|weather|gamerule|kill)/.test(c))).toBe(false)
    expect(cmds.filter((c) => c.startsWith('tp '))).toHaveLength(2)
    expect(cmds.filter((c) => c.endsWith(' chest'))).toHaveLength(2)
  })
})
