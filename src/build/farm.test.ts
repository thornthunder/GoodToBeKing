import { describe, expect, it } from 'vitest'
import { chooseFarm, extendFarm, farmNeed, MAX_FIELD } from './farm'
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
  })
})
