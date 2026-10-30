import { describe, expect, it } from 'vitest'
import { chooseFishingSpot } from './fishing'
import type { BlockNames } from './hall'

/** Flat grass at y 64, and a pond (x 10..16, z 10..16) at y 64, two deep, with sand round it. */
function land(pond = true): BlockNames {
  return (x, y, z) => {
    const inPond = pond && x >= 10 && x <= 16 && z >= 10 && z <= 16
    if (inPond && (y === 64 || y === 63)) return 'water'
    if (y > 64) return 'air'
    return y === 64 ? 'grass_block' : 'dirt'
  }
}

describe('a fishing spot', () => {
  it('finds open water near home and a dry spot on the shore beside it', () => {
    const spot = chooseFishingSpot(land(), { x: 0, y: 65, z: 0 })
    expect(spot).toBeDefined()
    const [wx, wy, wz] = spot!.water
    expect(wy).toBe(64)
    expect(wx >= 11 && wx <= 15 && wz >= 11 && wz <= 15).toBe(true)
    const [sx, sy, sz] = spot!.stand
    expect(sy).toBe(65)
    expect(sx < 10 || sx > 16 || sz < 10 || sz > 16).toBe(true)
    expect(Math.abs(sx - wx) + Math.abs(sz - wz)).toBeLessThanOrEqual(4)
  })

  it('finds none without water', () => {
    expect(chooseFishingSpot(land(false), { x: 0, y: 65, z: 0 }, 24)).toBeUndefined()
  })
})
