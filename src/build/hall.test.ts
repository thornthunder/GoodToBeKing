import { describe, expect, it } from 'vitest'
import { detectHallWork } from '../ai/abilities'
import { doorCells, floorCells, lightCells, roofCells, surveyHall, type BlockNames } from './hall'

/**
 * A dirt hall like the King's: 5 by 5 inside (x and z 0 to 4), feet at y 64, walls three high
 * (y 64 to 66) all round, and a doorway two high in the north wall at x 2.
 */
function hall(change: Record<string, string> = {}): BlockNames {
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (key in change) return change[key]
    if (y <= 63) return 'dirt'
    const wall =
      x >= -1 && x <= 5 && z >= -1 && z <= 5 && (x === -1 || x === 5 || z === -1 || z === 5)
    if (wall && y <= 66) return x === 2 && z === -1 && y <= 65 ? 'air' : 'dirt'
    return 'air'
  }
}

describe('the hall survey', () => {
  it('finds the room, its walls, how high they stand and the doorway', () => {
    const h = surveyHall(hall(), { x: 2.5, y: 64, z: 2.5 })
    if (typeof h === 'string') throw new Error(h)
    expect(h.inside).toHaveLength(25)
    expect(h.ring).toHaveLength(24)
    expect(h.wallTop).toBe(66)
    expect(h.openings).toEqual([[2, -1]])
  })

  it('says so when the walls are not closed at three high', () => {
    const leaky = hall({ '5,66,2': 'air' })
    expect(surveyHall(leaky, { x: 2, y: 64, z: 2 })).toContain('not closed all round')
  })

  it('knows a chest on the floor is not a wall', () => {
    const h = surveyHall(hall({ '1,64,1': 'chest' }), { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    expect(h.inside).toHaveLength(25)
    expect(floorCells(h, hall({ '1,64,1': 'chest' }))).toHaveLength(24)
  })

  it('plans a roof over room and walls, a plank floor, torches and a door', () => {
    const names = hall()
    const h = surveyHall(names, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    const roof = roofCells(h, names)
    expect(roof).toHaveLength(49)
    expect(roof.every((c) => c.y === 67 && c.block === 'planks')).toBe(true)
    const floor = floorCells(h, names)
    expect(floor).toHaveLength(25)
    expect(floor.every((c) => c.y === 63 && c.replace)).toBe(true)
    const torches = lightCells(h, names)
    expect(torches.length).toBeGreaterThan(1)
    expect(torches.every((c) => c.block === 'torch' && c.y === 65 && c.against)).toBe(true)
    expect(doorCells(h, names)).toEqual([{ x: 2, y: 64, z: -1, block: 'wooden_door' }])
  })

  it('never puts a torch on a door', () => {
    // A door in the doorway: the spot inside it has the door, not a wall, beside it.
    const names = hall({ '2,64,-1': 'wooden_door', '2,65,-1': 'wooden_door' })
    const h = surveyHall(names, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    const torches = lightCells(h, names)
    expect(torches.some((c) => c.x === 2 && c.z === 0 && c.against?.[2] === -1)).toBe(false)
  })

  it('raises a low wall to the roof, so it closes all round', () => {
    // One stretch of the east wall is a block higher than the rest.
    const names = hall({ '5,67,3': 'dirt' })
    const h = surveyHall(names, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    expect(h.wallTop).toBe(67)
    const roof = roofCells(h, names)
    expect(roof.filter((c) => c.y === 68)).toHaveLength(49)
    // Every other wall column, above the doorway too, gets one block more.
    expect(roof.filter((c) => c.y === 67)).toHaveLength(23)
  })
})

describe('detectHallWork', () => {
  it('hears what the hall needs', () => {
    expect(detectHallWork('Henry, put a roof on the hall please')).toBe('roof')
    expect(detectHallWork('lay a floor in our home')).toBe('floor')
    expect(detectHallWork('Festaris, light the hall')).toBe('light')
    expect(detectHallWork('can you make us a door')).toBe('door')
    expect(detectHallWork('where is the door?')).toBeNull()
    expect(detectHallWork('what a nice roof')).toBeNull()
  })
})
