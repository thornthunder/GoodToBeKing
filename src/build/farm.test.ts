import { describe, expect, it } from 'vitest'
import { chooseFarm, extendFarm, farmNeed, MAX_FIELD, waterCell, wateredFarm } from './farm'
import type { BlockNames } from './hall'

/** Flat grass at y 64, air above; `extra` adds water, walls and the like. */
function land(extra: Record<string, string> = {}): BlockNames {
  return (x, y, z) =>
    extra[`${x},${y},${z}`] ?? (y < 64 ? 'dirt' : y === 64 ? 'grass_block' : 'air')
}

describe('the farm', () => {
  it('lays a field of four by four on flat soil near home', () => {
    const farm = chooseFarm(land(), { x: 0, y: 65, z: 0 }, { reach: 8 })
    expect(farm?.cells).toHaveLength(16)
    expect(farm?.y).toBe(64)
    expect(farm?.watered).toBe(false)
  })

  it('goes by water when there is some, and keeps clear of the hall', () => {
    const farm = chooseFarm(land({ '6,64,6': 'water' }), { x: 0, y: 65, z: 0 }, { reach: 8 })
    expect(farm?.watered).toBe(true)
    const hall: Array<[number, number]> = [[0, 0]]
    const away = chooseFarm(land(), { x: 0, y: 65, z: 0 }, { reach: 8, keepClear: hall })
    expect(away?.cells.every(([x, z]) => Math.abs(x) > 3 || Math.abs(z) > 3)).toBe(true)
  })

  it('grows plot by plot beside the field, at its height, up to its largest', () => {
    let farm = chooseFarm(land(), { x: 0, y: 65, z: 0 }, { reach: 8 })!
    const first = new Set(farm.cells.map(([x, z]) => `${x},${z}`))
    farm = extendFarm(land(), farm)!
    expect(farm.cells).toHaveLength(32)
    expect(new Set(farm.cells.map(([x, z]) => `${x},${z}`)).size).toBe(32)
    expect(farm.cells.filter(([x, z]) => first.has(`${x},${z}`))).toHaveLength(16)
    while (farm.cells.length < MAX_FIELD) farm = extendFarm(land(), farm)!
    expect(extendFarm(land(), farm)).toBeUndefined()
    // Not over a hall.
    const small = chooseFarm(land(), { x: 0, y: 65, z: 0 }, { reach: 8 })!
    const walls: Array<[number, number]> = []
    for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) walls.push([x, z])
    expect(extendFarm(land(), small, { keepClear: walls })).toBeUndefined()
  })

  it('knows what each square needs', () => {
    expect(farmNeed('grass_block', 'air')).toBe('till')
    expect(farmNeed('dirt', 'short_grass')).toBe('till')
    expect(farmNeed('farmland', 'air')).toBe('plant')
    expect(farmNeed('farmland', 'wheat', 3)).toBeNull()
    expect(farmNeed('farmland', 'wheat', 7)).toBe('harvest')
    expect(farmNeed('stone', 'air')).toBeNull()
    // Its soil dug out: dirt goes in first.
    expect(farmNeed('air', 'air')).toBe('fill')
  })
})

describe('water for the field', () => {
  it("goes into the square nearest the field's middle, which leaves the field", () => {
    const cells: Array<[number, number]> = []
    for (let x = 94; x < 98; x++) for (let z = 6; z < 10; z++) cells.push([x, z])
    const farm = { y: 68, cells, watered: false }
    const at = waterCell(farm)
    // The middle of 94..97 and 6..9 is 95.5, 7.5: one of the four squares round it.
    expect(at && Math.hypot(at[0] - 95.5, at[1] - 7.5)).toBeCloseTo(Math.SQRT1_2)
    const wet = wateredFarm(farm, at as [number, number])
    expect(wet.cells).toHaveLength(15)
    expect(wet).toMatchObject({ watered: true, water: at })
    // Every square left drinks: within four of the water.
    expect(
      wet.cells.every(([x, z]) => Math.max(Math.abs(x - at![0]), Math.abs(z - at![1])) <= 4)
    ).toBe(true)
  })
})
