import { describe, expect, it } from 'vitest'
import { EstateBook, SETTLE_MS } from './EstateBook'
import type { BlockNames } from './hall'
import {
  darkSpots,
  estateDoorCells,
  estateLightCells,
  estateRepairCells,
  estateWords,
  homeRoom,
  isMade,
  surveyEstate,
} from './estate'

/**
 * A stone house the King built: walls x 0 to 10, z 0 to 6, four high (y 64 to 67) under a
 * plank roof at 68, a plank floor. An inner wall at x 5 with a doorway at z 3 splits it into a
 * bedchamber (west, a bed) and a kitchen (east, a furnace, a crafting table, a torch). The way
 * in is a doorway at x 7 in the south wall, without a door. A fence runs east of it.
 */
function house(change: Record<string, string> = {}): BlockNames {
  return (x, y, z) => {
    const k = `${x},${y},${z}`
    if (k in change) return change[k]
    if (y < 63) return 'dirt'
    const inHouse = x >= 0 && x <= 10 && z >= 0 && z <= 6
    if (y === 63) return inHouse ? 'oak_planks' : 'grass_block'
    if (inHouse && y === 68) return 'oak_planks'
    if (y >= 64 && y <= 67 && inHouse) {
      const outer = x === 0 || x === 10 || z === 0 || z === 6
      if (outer) return x === 7 && z === 6 && y <= 65 ? 'air' : 'stone_bricks'
      if (x === 5) return z === 3 && y <= 65 ? 'air' : 'stone_bricks'
      if (y === 64 && x === 1 && (z === 1 || z === 2)) return 'bed'
      if (y === 64 && x === 9 && z === 5) return 'furnace'
      if (y === 64 && x === 9 && z === 1) return 'crafting_table'
      if (y === 65 && x === 6 && z === 3) return 'torch'
      return 'air'
    }
    if (y === 64 && z === 0 && x >= 20 && x <= 30) return 'oak_fence'
    return 'air'
  }
}

const HOME = { x: 2, y: 64, z: 4 }

describe('the estate survey', () => {
  it('finds the buildings, their rooms and what the rooms are for', () => {
    const estate = surveyEstate(house(), HOME, { radius: 34 })
    expect(estate.buildings).toHaveLength(2)
    const [home, fence] = estate.buildings
    expect(home.home).toBe(true)
    expect([home.x, home.z, home.width, home.depth]).toEqual([0, 0, 11, 7])
    expect(home.materials.sort()).toEqual(['oak planks', 'stone bricks'])
    const kinds = home.rooms.map((r) => r.kind).sort()
    expect(kinds).toEqual(['bedchamber', 'kitchen'])
    const kitchen = home.rooms.find((r) => r.kind === 'kitchen')!
    expect(kitchen.furniture).toEqual({ furnace: 1, crafting_table: 1 })
    expect(home.rooms.find((r) => r.kind === 'bedchamber')!.furniture).toEqual({ bed: 1 })
    expect(fence.rooms).toEqual([])
    // The way in has no door; the doorway between the rooms is no way in.
    expect(estate.doorless).toEqual([[7, 64, 6]])
    expect(estate.doors).toBe(0)
  })

  it('knows every block players placed, and nothing the world grew', () => {
    const estate = surveyEstate(house(), HOME, { radius: 34 })
    expect(estate.made['0,64,0']).toBe('stone_bricks')
    expect(estate.made['3,63,3']).toBe('oak_planks')
    expect(estate.made['20,64,0']).toBe('oak_fence')
    expect(estate.made['15,63,3']).toBeUndefined()
    expect(isMade('grass_block')).toBe(false)
    expect(isMade('oak_log')).toBe(false)
    expect(isMade('wheat')).toBe(false)
    expect(isMade('cobblestone')).toBe(true)
  })

  it('finds the dark corners and lights them all with torches', () => {
    const names = house()
    const estate = surveyEstate(names, HOME, { radius: 34 })
    const dark = darkSpots(estate, names)
    const at = (x: number, z: number) => dark.some(([dx, , dz]) => dx === x && dz === z)
    // The kitchen's torch lights both rooms (through the doorway); the far ground is dark.
    expect(at(8, 3)).toBe(false)
    expect(at(3, 3)).toBe(false)
    expect(at(-3, -3)).toBe(true)
    // Without it the house is dark, and the torches go on its walls at head height.
    const unlit = house({ '6,65,3': 'air' })
    const torches = estateLightCells(estate, unlit, 64)
    const inside = torches.find((t) => t.x >= 1 && t.x <= 9 && t.z >= 1 && t.z <= 5)
    expect(inside?.y).toBe(65)
    expect(inside?.against?.[1]).toBe(0)
    const lit: Record<string, string> = { '6,65,3': 'air' }
    for (const t of torches) lit[`${t.x},${t.y},${t.z}`] = 'torch'
    expect(darkSpots(estate, house(lit))).toEqual([])
  })

  it('hangs a door in the way in', () => {
    const names = house()
    const estate = surveyEstate(names, HOME, { radius: 34 })
    expect(estateDoorCells(estate, names)).toEqual([{ x: 7, y: 64, z: 6, block: 'wooden_door' }])
  })

  it('mends what was blown away, as it was where the storehouse has it', () => {
    const before = surveyEstate(house(), HOME, { radius: 34 }).made
    const blown = house({ '0,65,2': 'air', '0,66,2': 'air', '0,64,3': 'air', '6,65,3': 'air' })
    const cells = estateRepairCells(before, blown)
    // The torch is the light's business, not a repair.
    expect(cells.map((c) => [c.x, c.y, c.z])).toEqual([
      [0, 64, 3],
      [0, 65, 2],
      [0, 66, 2],
    ])
    expect(cells.every((c) => c.block === 'filler')).toBe(true)
    const same = estateRepairCells(before, blown, (b) => b === 'stone_bricks')
    expect(same.every((c) => c.block === 'stone_bricks')).toBe(true)
    // A block that is not loaded is not known to be lost.
    const unseen: BlockNames = (x, y, z) => (x === 0 ? undefined : blown(x, y, z))
    expect(estateRepairCells(before, unseen)).toEqual([])
  })

  it('takes the room the home is in for the hall', () => {
    const names = house()
    const estate = surveyEstate(names, HOME, { radius: 34 })
    const hall = homeRoom(estate, names)
    expect(hall?.floorY).toBe(64)
    // The bedchamber's floor: 4 by 5 less the bed.
    expect(hall?.inside).toHaveLength(18)
    expect(hall?.openings).toContainEqual([5, 3])
    expect(hall?.wallTop).toBe(67)
  })

  it('says what stands there in words', () => {
    const names = house()
    const estate = surveyEstate(names, HOME, { radius: 34 })
    const words = estateWords(estate, darkSpots(estate, names).length)
    expect(words).toContain('Building 1: 11 by 7 blocks and 6 high (the one the home is in)')
    expect(words).toContain('a bedchamber 4 by 5 (1 bed)')
    expect(words).toContain('a kitchen')
    expect(words).toContain('1 way in without a door')
    expect(words).toMatch(/\d+ spots in and round it are dark/)
  })
})

describe('the estate book', () => {
  const book = () => new EstateBook()
  const near = () => true
  const far = () => false
  const seen = () => true

  it('keeps new blocks once they have stood a while, and lets scaffolding go', () => {
    const b = book()
    const t = 1_000_000
    b.found(surveyEstate(house(), HOME, { radius: 34 }), 'a house', 'BigDad', t)
    const tower = house({ '12,64,3': 'cobblestone', '12,65,3': 'cobblestone' })
    b.update(surveyEstate(tower, HOME, { radius: 34 }), 'a house', far, seen, t + 60_000)
    expect(b.record?.made['12,64,3']).toBeUndefined()
    // Taken down again before it settled: never part of the estate.
    b.update(surveyEstate(house(), HOME, { radius: 34 }), 'a house', far, seen, t + 120_000)
    expect(b.record?.pending['12,64,3']).toBeUndefined()
    // A porch the King adds stays.
    const porch = house({ '7,64,8': 'oak_planks' })
    b.update(surveyEstate(porch, HOME, { radius: 34 }), 'a house', far, seen, t + 180_000)
    b.update(
      surveyEstate(porch, HOME, { radius: 34 }),
      'a house',
      far,
      seen,
      t + 180_000 + SETTLE_MS
    )
    expect(b.record?.made['7,64,8']).toBe('oak_planks')
  })

  it('lets a block go that went while a royal was about, and keeps the rest to mend', () => {
    const b = book()
    b.found(surveyEstate(house(), HOME, { radius: 34 }), 'a house', 'BigDad')
    const window = house({ '3,65,0': 'air' })
    b.update(surveyEstate(window, HOME, { radius: 34 }), 'a house', near, seen)
    expect(b.record?.made['3,65,0']).toBeUndefined()
    const blown = house({ '3,65,0': 'air', '0,65,2': 'air' })
    b.update(surveyEstate(blown, HOME, { radius: 34 }), 'a house', far, seen)
    expect(b.record?.made['0,65,2']).toBe('stone_bricks')
    expect(estateRepairCells(b.record!.made, blown).map((c) => [c.x, c.y, c.z])).toEqual([
      [0, 65, 2],
    ])
  })
})
