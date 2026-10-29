import { describe, expect, it } from 'vitest'
import { plan, type CourtState } from './steward'

const base: CourtState = {
  royalNear: false,
  merlinAwake: true,
  magicLeft: 10,
  guardsUnarmed: [],
  courtiers: 6,
  bedsInHall: 6,
  freeBuilder: 'Henry',
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
  freeHand: 'Bruce',
  storehouse: true,
  night: false,
}

describe("the Castellan's account", () => {
  it('has nothing to do when the court has all it needs', () => {
    expect(plan(base)).toEqual([])
  })

  it('roofs the hall before anything else, then the door', () => {
    expect(plan({ ...base, hall: { roof: 40, door: 1, light: 2, repair: 3 } })[0]).toEqual({
      kind: 'hallwork',
      work: 'repair',
    })
    expect(plan({ ...base, hall: { roof: 40, door: 1, light: 2, repair: 0 } })[0]).toEqual({
      kind: 'hallwork',
      work: 'roof',
    })
    expect(plan({ ...base, hall: { roof: 0, door: 1, light: 0, repair: 0 } })[0]).toEqual({
      kind: 'hallwork',
      work: 'door',
    })
  })

  it('has guards make their own swords; Merlin conjures them only with nothing to make one of', () => {
    expect(plan({ ...base, guardsUnarmed: ['Bruce'] })).toContainEqual({ kind: 'arm', by: 'Bruce' })
    const bare = {
      ...base,
      cobblestone: 0,
      woodInStore: 0,
      guardsUnarmed: ['Bruce'],
      bedsInHall: 0,
    }
    const unarmed = plan(bare)
    expect(unarmed).toContainEqual({
      kind: 'magic',
      item: 'iron_sword',
      count: 1,
      to: 'Bruce',
      why: 'a sword for Bruce',
    })
    expect(plan({ ...base, bedsInHall: 2 })).toContainEqual({
      kind: 'magic',
      item: 'bed',
      count: 4,
      to: 'Henry',
      then: 'beds',
      why: 'beds for the court',
    })
    // The builder already has them: he puts them up.
    expect(plan({ ...base, bedsInHall: 2, builderWithBeds: 'George' })).toContainEqual({
      kind: 'hallwork',
      work: 'beds',
      by: 'George',
    })
  })

  it('asks the royal family instead when one is near, and keeps magic for them', () => {
    const empty = { ...base, foodInStore: 0, withoutFood: ['Dyke'] }
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

  it('feeds the court by hand first: cooks what was hunted, else hunts', () => {
    const low = { ...base, foodInStore: 2, freeHunter: 'Bruce' }
    expect(plan({ ...low, rawInStore: 5 })).toEqual([{ kind: 'cook', by: 'Bruce' }])
    expect(plan(low)).toEqual([{ kind: 'hunt', animals: 3, by: 'Bruce' }])
    // No bread by magic while there is meat to cook.
    expect(plan({ ...low, rawInStore: 5, withoutFood: ['Dyke'] })).toEqual([
      { kind: 'cook', by: 'Bruce' },
    ])
    // No furnace yet: the builders make one of cobblestone; Merlin's only when there is no stone.
    expect(plan({ ...low, rawInStore: 5, furnace: false })).toContainEqual({
      kind: 'hallwork',
      work: 'furnace',
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

  it('lays out a wheat field, tends it, and asks Merlin for seeds only to start it', () => {
    expect(plan({ ...base, farm: { exists: false, work: 0 } })).toEqual([
      { kind: 'farm', by: 'Bruce' },
    ])
    expect(plan({ ...base, farm: { exists: true, work: 3 } })).toEqual([
      { kind: 'farm', by: 'Bruce' },
    ])
    expect(plan({ ...base, farm: { exists: false, work: 0 }, seeds: 0 })).toContainEqual({
      kind: 'magic',
      item: 'wheat_seeds',
      count: 8,
      to: 'Bruce',
      why: 'seeds for a wheat field',
    })
  })

  it('has a new chest made when the storehouse was blown up, after the repairs', () => {
    expect(plan({ ...base, storehouse: false, storehouseLost: true })[0]).toEqual({
      kind: 'hallwork',
      work: 'chest',
    })
  })

  it('makes charcoal for the torches from its own logs, magic coal only without a furnace', () => {
    const dark = {
      ...base,
      hall: { roof: 0, door: 0, light: 6, repair: 0 },
      freeBuilder: undefined,
    }
    expect(plan(dark)).toContainEqual({ kind: 'charcoal', by: 'Bruce' })
    // No furnace: one is made first (of cobblestone), and charcoal after; no magic coal.
    expect(plan({ ...dark, furnace: false, freeBuilder: 'Henry' })).toContainEqual({
      kind: 'hallwork',
      work: 'furnace',
    })
  })

  it('mines for stone by day when the storehouse runs short, and stops for good where the mine ended', () => {
    expect(plan({ ...base, cobblestone: 4 })).toContainEqual({
      kind: 'mine',
      by: 'Bruce',
      want: 24,
    })
    expect(plan({ ...base, cobblestone: 4, night: true })).toEqual([])
    expect(plan({ ...base, cobblestone: 4, mineEnded: true })).toEqual([])
  })

  it('sends nobody out at night: no field, no hunt, no wood; cooking indoors goes on', () => {
    const night = { ...base, night: true, foodInStore: 2, freeHunter: 'Dyke', woodInStore: 3 }
    expect(plan({ ...night, farm: { exists: true, work: 4 } })).toEqual([])
    expect(plan({ ...night, rawInStore: 4 })).toEqual([{ kind: 'cook', by: 'Dyke' }])
  })

  it('sends a free hand for wood when the storehouse runs low', () => {
    expect(plan({ ...base, woodInStore: 3 })).toEqual([
      { kind: 'errand', material: 'wood', count: 16 },
    ])
    expect(plan({ ...base, woodInStore: 3, freeHand: undefined })).toEqual([])
  })
})
