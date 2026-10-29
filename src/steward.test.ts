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
  hall: { roof: 0, door: 0, light: 0 },
  storeHasCoal: false,
  withoutFood: [],
  foodInStore: 10,
  rawInStore: 0,
  furnace: true,
  woodInStore: 20,
  freeHand: 'Bruce',
  storehouse: true,
}

describe("the Castellan's account", () => {
  it('has nothing to do when the court has all it needs', () => {
    expect(plan(base)).toEqual([])
  })

  it('roofs the hall before anything else, then the door', () => {
    expect(plan({ ...base, hall: { roof: 40, door: 1, light: 2 } })[0]).toEqual({
      kind: 'hallwork',
      work: 'roof',
    })
    expect(plan({ ...base, hall: { roof: 0, door: 1, light: 0 } })[0]).toEqual({
      kind: 'hallwork',
      work: 'door',
    })
  })

  it('has Merlin conjure swords, then beds for a builder to put up', () => {
    const unarmed = plan({ ...base, guardsUnarmed: ['Bruce'], bedsInHall: 0 })
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
    // No furnace yet: Merlin conjures one, and a builder puts it in.
    expect(plan({ ...low, rawInStore: 5, furnace: false })).toContainEqual({
      kind: 'magic',
      item: 'furnace',
      count: 1,
      to: 'Henry',
      then: 'furnace',
      why: 'a furnace for the hall',
    })
  })

  it('sends a free hand for wood when the storehouse runs low', () => {
    expect(plan({ ...base, woodInStore: 3 })).toEqual([
      { kind: 'errand', material: 'wood', count: 16 },
    ])
    expect(plan({ ...base, woodInStore: 3, freeHand: undefined })).toEqual([])
  })
})
