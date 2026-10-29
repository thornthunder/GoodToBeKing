import { describe, expect, it } from 'vitest'
import { plan, type CourtState } from './steward'

/** A court that has all it needs: Henry and George build, Bruce and Dyke guard, all free. */
const base: CourtState = {
  royalNear: false,
  merlinAwake: true,
  magicLeft: 10,
  guardsUnarmed: [],
  courtiers: 6,
  bedsInHall: 6,
  freeBuilder: 'Henry',
  freeBuilders: ['Henry', 'George'],
  freeHands: ['Henry', 'George', 'Bruce', 'Dyke'],
  guards: ['Bruce', 'Dyke'],
  hall: { roof: 0, door: 0, light: 0, repair: 0 },
  storeHasCoal: false,
  withoutFood: [],
  foodInStore: 10,
  rawInStore: 0,
  furnace: true,
  farm: { exists: true, work: 0 },
  seeds: 8,
  cobblestone: 40,
  mineEnded: false,
  woodInStore: 20,
  storehouse: true,
  night: false,
}
const kinds = (s: CourtState) => plan(s).map((a) => `${a.kind}:${'by' in a ? a.by : ''}`)

describe("the Castellan's account", () => {
  it('has nothing to do when the court has all it needs', () => {
    expect(plan(base)).toEqual([])
  })

  it('mends the hall first, then roof and door, each to its own builder', () => {
    const hall = { ...base, hall: { roof: 40, door: 1, light: 0, repair: 3 } }
    expect(plan(hall).filter((a) => a.kind === 'hallwork')).toEqual([
      { kind: 'hallwork', work: 'repair', by: 'Henry' },
      { kind: 'hallwork', work: 'roof', by: 'George' },
    ])
  })

  it('has the storehouse remade while the other builder mends', () => {
    const lost = {
      ...base,
      storehouse: false,
      storehouseLost: true,
      hall: { roof: 0, door: 0, light: 0, repair: 4 },
    }
    expect(plan(lost).filter((a) => a.kind === 'hallwork')).toEqual([
      { kind: 'hallwork', work: 'repair', by: 'Henry' },
      { kind: 'hallwork', work: 'chest', by: 'George' },
    ])
  })

  it('never gives one courtier two jobs in a round', () => {
    const busy = {
      ...base,
      hall: { roof: 0, door: 0, light: 0, repair: 2 },
      farm: { exists: true, work: 4 },
      cobblestone: 4,
      woodInStore: 6,
    }
    const who = plan(busy).flatMap((a) => ('by' in a && a.by ? [a.by] : []))
    expect(new Set(who).size).toBe(who.length)
    expect(kinds(busy)).toEqual(['hallwork:Henry', 'farm:George', 'mine:Bruce', 'errand:Dyke'])
  })

  it('has guards make their own swords; Merlin conjures them only with nothing to make one of', () => {
    expect(plan({ ...base, guardsUnarmed: ['Bruce'] })).toContainEqual({ kind: 'arm', by: 'Bruce' })
    const bare = { ...base, cobblestone: 0, woodInStore: 0, guardsUnarmed: ['Bruce'] }
    expect(plan(bare)).toContainEqual({
      kind: 'magic',
      item: 'iron_sword',
      count: 1,
      to: 'Bruce',
      why: 'a sword for Bruce',
    })
  })

  it('has Merlin conjure beds for a builder to put up, who then puts them up', () => {
    expect(plan({ ...base, bedsInHall: 2 })).toContainEqual({
      kind: 'magic',
      item: 'bed',
      count: 4,
      to: 'Henry',
      then: 'beds',
      why: 'beds for the court',
    })
    expect(plan({ ...base, bedsInHall: 2, builderWithBeds: 'George' })).toContainEqual({
      kind: 'hallwork',
      work: 'beds',
      by: 'George',
    })
  })

  it('asks the royal family instead when one is near, and keeps magic for them', () => {
    const empty = {
      ...base,
      foodInStore: 0,
      withoutFood: ['Dyke'],
      freeHands: [],
      freeBuilders: [],
      freeBuilder: undefined,
    }
    expect(plan({ ...empty, royalNear: true })).toContainEqual({
      kind: 'ask',
      what: 'food for Dyke',
    })
    expect(plan({ ...empty, magicLeft: 5 }).filter((a) => a.kind === 'magic')).toEqual([])
    expect(plan({ ...empty, magicLeft: 6 })).toContainEqual({
      kind: 'magic',
      item: 'bread',
      count: 4,
      to: 'Dyke',
      why: 'food for Dyke',
    })
  })

  it('feeds the court by hand: cooks what was hunted, else a guard hunts', () => {
    const low = { ...base, foodInStore: 2 }
    expect(plan({ ...low, rawInStore: 5 })).toEqual([{ kind: 'cook', by: 'Bruce' }])
    expect(plan(low)).toEqual([{ kind: 'hunt', animals: 3, by: 'Bruce' }])
    // No furnace yet: the builders make one of cobblestone; Merlin's only when there is no stone.
    expect(plan({ ...low, rawInStore: 5, furnace: false })).toContainEqual({
      kind: 'hallwork',
      work: 'furnace',
      by: 'Henry',
    })
    const noStone = { ...low, rawInStore: 5, furnace: false, cobblestone: 0, mineEnded: true }
    expect(plan(noStone)).toContainEqual({
      kind: 'magic',
      item: 'furnace',
      count: 1,
      to: 'Henry',
      then: 'furnace',
      why: 'a furnace for the hall',
    })
  })

  it('makes charcoal for the torches from its own logs; magic coal only without a furnace', () => {
    const dark = { ...base, hall: { roof: 0, door: 0, light: 6, repair: 0 } }
    expect(kinds(dark)).toContain('charcoal:Henry')
    const coalless = { ...dark, furnace: false, cobblestone: 0, mineEnded: true }
    expect(plan(coalless)).toContainEqual({
      kind: 'magic',
      item: 'furnace',
      count: 1,
      to: 'Henry',
      then: 'furnace',
      why: 'a furnace for the hall',
    })
  })

  it('lays out a wheat field and tends it (not a guard); Merlin seeds only to start it', () => {
    expect(kinds({ ...base, farm: { exists: false, work: 0 } })).toEqual(['farm:Henry'])
    const guardsFirst = {
      ...base,
      freeHands: ['Bruce', 'George'],
      freeBuilders: ['George'],
      farm: { exists: true, work: 3 },
    }
    expect(kinds(guardsFirst)).toEqual(['farm:George'])
    expect(plan({ ...base, farm: { exists: false, work: 0 }, seeds: 0 })).toContainEqual({
      kind: 'magic',
      item: 'wheat_seeds',
      count: 8,
      to: 'Henry',
      why: 'seeds for a wheat field',
    })
  })

  it('faces the dirt walls with stone once there is cobblestone to spare', () => {
    const earthen = { ...base, hall: { roof: 0, door: 0, light: 0, repair: 0, earth: 30 } }
    expect(plan(earthen)).toContainEqual({ kind: 'hallwork', work: 'reinforce', by: 'Henry' })
    expect(plan({ ...earthen, cobblestone: 4 }).some((a) => a.kind === 'hallwork')).toBe(false)
  })

  it('mines before the field while there is no furnace', () => {
    const early = { ...base, furnace: false, cobblestone: 0, farm: { exists: true, work: 4 } }
    expect(kinds(early).slice(0, 2)).toEqual(['mine:Henry', 'farm:George'])
  })

  it('mines for stone by day when the storehouse runs short, and not where the mine ended', () => {
    expect(plan({ ...base, cobblestone: 4 })).toContainEqual({
      kind: 'mine',
      by: 'Henry',
      want: 24,
    })
    expect(plan({ ...base, cobblestone: 4, night: true })).toEqual([])
    expect(plan({ ...base, cobblestone: 4, mineEnded: true })).toEqual([])
  })

  it('sends nobody out at night: no field, no hunt, no wood; cooking indoors goes on', () => {
    const night = { ...base, night: true, foodInStore: 2, woodInStore: 3 }
    expect(plan({ ...night, farm: { exists: true, work: 4 } })).toEqual([])
    expect(plan({ ...night, rawInStore: 4 })).toEqual([{ kind: 'cook', by: 'Bruce' }])
  })

  it('fetches wood before the field and the mine when there is hardly any', () => {
    const bare = { ...base, woodInStore: 1, farm: { exists: true, work: 4 }, cobblestone: 4 }
    expect(kinds(bare).slice(0, 1)).toEqual(['errand:Henry'])
  })

  it('rests work that came to nothing, and has Merlin conjure wood when there is none to find', () => {
    const bare = {
      ...base,
      woodInStore: 0,
      farm: { exists: true, work: 4 },
      resting: ['wood', 'farm'],
    }
    expect(kinds(bare)).not.toContain('errand:Henry')
    expect(kinds(bare).some((k) => k.startsWith('farm'))).toBe(false)
    expect(plan(bare)).toContainEqual({
      kind: 'magic',
      item: 'oak_log',
      count: 8,
      to: 'Henry',
      why: 'wood for the court',
    })
    const doorless = {
      ...base,
      hall: { roof: 0, door: 1, light: 0, repair: 0 },
      resting: ['hallwork:door'],
    }
    expect(plan(doorless)).toEqual([])
  })

  it('sends a free hand for wood when the storehouse runs low', () => {
    expect(plan({ ...base, woodInStore: 3 })).toEqual([
      { kind: 'errand', material: 'wood', count: 16, by: 'Henry' },
    ])
    const nobody = {
      ...base,
      woodInStore: 3,
      freeHands: [],
      freeBuilders: [],
      freeBuilder: undefined,
    }
    expect(plan(nobody)).toEqual([])
  })
})
