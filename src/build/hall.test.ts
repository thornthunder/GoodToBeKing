import { describe, expect, it } from 'vitest'
import { detectHallWork } from '../ai/abilities'
import {
  bedCells,
  doorCells,
  floorCells,
  reinforceCells,
  repairCells,
  lightCells,
  roofCells,
  surveyHall,
  type BlockNames,
} from './hall'

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
    expect(torches.every((c) => c.block === 'torch' && c.against)).toBe(true)
    // On the inside walls at head height, and standing on the ground outside (one above it).
    const inside = torches.filter((c) => c.x >= 0 && c.x <= 4 && c.z >= 0 && c.z <= 4)
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.every((c) => c.y === 65)).toBe(true)
    const outside = torches.filter((c) => !inside.includes(c))
    expect(outside.length).toBeGreaterThan(3)
    expect(outside.every((c) => c.y === 64 && c.against?.[1] === -1)).toBe(true)
    // With those torches up, none are wanted any more.
    const lit = hall(Object.fromEntries(torches.map((c) => [`${c.x},${c.y},${c.z}`, 'torch'])))
    expect(lightCells(h, lit)).toEqual([])
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
    expect(detectHallWork('Festaris, put beds in the hall')).toBe('beds')
    expect(detectHallWork('where is the door?')).toBeNull()
    expect(detectHallWork('what a nice roof')).toBeNull()
  })
})

describe('beds', () => {
  it('puts beds along the walls, head to the wall, none before the door', () => {
    const names = hall()
    const h = surveyHall(names, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    const beds = bedCells(h, names, 8)
    expect(beds.length).toBeGreaterThanOrEqual(2)
    for (const b of beds) {
      const [dx, dz] = b.head!
      // The head next to the wall ring, the foot inside, nowhere near the doorway at 2,-1.
      expect(names(b.x + 2 * dx, 64, b.z + 2 * dz)).toBe('dirt')
      expect(Math.abs(b.x + dx - 2) + Math.abs(b.z + dz + 1)).toBeGreaterThan(2)
    }
    expect(bedCells(h, names, 1)).toHaveLength(1)
  })
})

describe('a roofed hall', () => {
  it('knows the roof is not wall: the walls stop under it', () => {
    const roofed: Record<string, string> = {}
    for (let x = -1; x <= 5; x++)
      for (let z = -1; z <= 5; z++) roofed[`${x},67,${z}`] = 'oak_planks'
    const names = hall(roofed)
    const h = surveyHall(names, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    expect(h.wallTop).toBe(66)
    expect(roofCells(h, names)).toEqual([])
    // A hole in the roof is a repair.
    const holed = hall({ ...roofed, '2,67,2': 'air' })
    expect(repairCells(h, holed)).toEqual([{ x: 2, y: 67, z: 2, block: 'filler' }])
  })
})

describe('stone facing', () => {
  it('turns the dirt of walls and roof to cobblestone, leaving the doorway and planks be', () => {
    const names = hall()
    const h = surveyHall(names, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    const stone = reinforceCells(h, names)
    // 24 wall columns three high, less the doorway's two blocks.
    expect(stone).toHaveLength(24 * 3 - 2)
    expect(stone.every((c) => c.block === 'stone' && c.replace)).toBe(true)
    const planked = hall({ '5,64,2': 'oak_planks' })
    expect(reinforceCells(h, planked)).toHaveLength(24 * 3 - 3)
  })
})

describe('repairs', () => {
  it('fills the holes in walls and roof with planks, but keeps the doorway open', () => {
    const whole = hall()
    const h = surveyHall(whole, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    // An enderman took two wall blocks; no roof yet, so nothing for the roof.
    const damaged = hall({ '5,65,2': 'air', '-1,66,4': 'air' })
    const fix = repairCells(h, damaged)
    expect(fix.map((c) => `${c.x},${c.y},${c.z}`).sort()).toEqual(['-1,66,4', '5,65,2'])
    expect(fix.every((c) => c.block === 'filler')).toBe(true)
    expect(repairCells(h, whole)).toEqual([])
  })

  it('fills a crater in the floor from the bottom up, planks on top', () => {
    const whole = hall()
    const h = surveyHall(whole, { x: 2, y: 64, z: 2 })
    if (typeof h === 'string') throw new Error(h)
    // A creeper blew a hole two deep where the floor was.
    const crater = hall({ '2,63,2': 'air', '2,62,2': 'air' })
    expect(repairCells(h, crater)).toEqual([
      { x: 2, y: 62, z: 2, block: 'dirt' },
      { x: 2, y: 63, z: 2, block: 'filler' },
    ])
  })
})
