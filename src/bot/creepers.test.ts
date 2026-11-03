import { describe, expect, it } from 'vitest'
import { chooseLure, leadPoint, lurePoint, LEAD_STEP, LURE_FAR } from './creepers'

describe('luring a creeper away from the hall', () => {
  it('sends the nearest fit soldier, else anyone fit but the captain, else whoever is best off', () => {
    expect(
      chooseLure([
        { name: 'Bram', soldier: false, captain: true, health: 20, distance: 3 },
        { name: 'Bevis', soldier: false, captain: false, health: 20, distance: 4 },
        { name: 'Brock', soldier: true, captain: false, health: 12, distance: 9 },
        { name: 'Barnaby', soldier: true, captain: false, health: 5, distance: 2 },
      ])
    ).toBe('Brock')
    expect(
      chooseLure([
        { name: 'Bram', soldier: false, captain: true, health: 20, distance: 3 },
        { name: 'Bevis', soldier: false, captain: false, health: 20, distance: 4 },
        { name: 'Barnaby', soldier: true, captain: false, health: 5, distance: 2 },
      ])
    ).toBe('Bevis')
    expect(
      chooseLure([
        { name: 'Bram', soldier: false, captain: true, health: 6, distance: 3 },
        { name: 'Barnaby', soldier: true, captain: false, health: 5, distance: 2 },
      ])
    ).toBe('Bram')
  })

  it('never sends a raider, and nobody when nobody can go', () => {
    expect(
      chooseLure([
        {
          name: 'Brock',
          soldier: true,
          captain: false,
          health: 20,
          distance: 2,
          unavailable: true,
        },
        { name: 'Bevis', soldier: false, captain: false, health: 20, distance: 9 },
      ])
    ).toBe('Bevis')
    expect(
      chooseLure([
        {
          name: 'Brock',
          soldier: true,
          captain: false,
          health: 20,
          distance: 2,
          unavailable: true,
        },
      ])
    ).toBeUndefined()
  })

  it('leads the creeper out past itself, far from home; one inside goes out by the doorway', () => {
    const home = { x: 0, y: 64, z: 0 }
    expect(lurePoint(home, { x: 6, y: 64, z: 8 })).toEqual({ x: 18, y: 64, z: 24 })
    expect(lurePoint(home, { x: 1, y: 64, z: 1 }, { x: 0, z: 4 })).toEqual({
      x: 0,
      y: 64,
      z: LURE_FAR,
    })
    // No doorway known and the creeper at home: south it is.
    expect(lurePoint(home, home)).toEqual({ x: 0, y: 64, z: LURE_FAR })
  })
})

describe('leading a creeper', () => {
  it('leads straight away from the creeper, and sideways when that would be towards home', () => {
    const home = { x: 0, y: 64, z: 0 }
    // The creeper east of the lure, the lure east of home: west would be home, so sideways.
    const p = leadPoint(home, { x: 10, y: 64, z: 0 }, { x: 14, y: 64, z: 0 })
    expect(p.x).toBe(10)
    expect(Math.abs(p.z)).toBe(LEAD_STEP)
    // The creeper between home and the lure: straight on, away from both.
    expect(leadPoint(home, { x: 10, y: 64, z: 0 }, { x: 6, y: 64, z: 0 })).toEqual({
      x: 10 + LEAD_STEP,
      y: 64,
      z: 0,
    })
    // On top of it: away from home.
    expect(leadPoint(home, { x: 0, y: 64, z: 8 }, { x: 0, y: 64, z: 8 })).toEqual({
      x: 0,
      y: 64,
      z: 8 + LEAD_STEP,
    })
  })
})
