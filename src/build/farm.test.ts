import { describe, expect, it } from 'vitest'
import { chooseFarm, farmNeed } from './farm'
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

  it('knows what each square needs', () => {
    expect(farmNeed('grass_block', 'air')).toBe('till')
    expect(farmNeed('dirt', 'short_grass')).toBe('till')
    expect(farmNeed('farmland', 'air')).toBe('plant')
    expect(farmNeed('farmland', 'wheat', 3)).toBeNull()
    expect(farmNeed('farmland', 'wheat', 7)).toBe('harvest')
    expect(farmNeed('stone', 'air')).toBeNull()
  })
})
