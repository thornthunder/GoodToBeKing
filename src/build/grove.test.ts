import { describe, expect, it } from 'vitest'
import { chooseGrove, groveNeed } from './grove'
import type { BlockNames } from './hall'

/** Flat grass at y 64 everywhere, air above, plus whatever `extra` puts in. */
function land(extra: Record<string, string> = {}): BlockNames {
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (key in extra) return extra[key]
    if (y > 64) return 'air'
    return y === 64 ? 'grass_block' : 'dirt'
  }
}

const home = { x: 0, y: 65, z: 0 }

describe("the court's grove", () => {
  it('plants six trees near home, five apart, clear of the hall', () => {
    const hall: Array<[number, number]> = []
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) hall.push([x, z])
    const grove = chooseGrove(land(), home, { keepClear: hall })
    expect(grove?.spots).toHaveLength(6)
    for (const [x, y, z] of grove!.spots) {
      expect(y).toBe(64)
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(8)
      expect(hall.some(([hx, hz]) => Math.abs(hx - x) < 6 && Math.abs(hz - z) < 6)).toBe(false)
    }
    for (const a of grove!.spots)
      for (const b of grove!.spots)
        if (a !== b)
          expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[2] - b[2]))).toBeGreaterThanOrEqual(5)
  })

  it('needs room above a sapling for the tree to grow', () => {
    // A plank roof over the whole land four blocks up: nowhere to grow.
    const roofed: Record<string, string> = {}
    for (let x = -32; x <= 32; x++)
      for (let z = -32; z <= 32; z++) roofed[`${x},68,${z}`] = 'oak_planks'
    expect(chooseGrove(land(roofed), home)).toBeUndefined()
  })

  it('fells a grown tree, plants bare soil, and waits while a sapling grows', () => {
    expect(groveNeed('grass_block', 'birch_log')).toBe('fell')
    expect(groveNeed('dirt', 'air')).toBe('plant')
    expect(groveNeed('grass_block', 'short_grass')).toBe('plant')
    expect(groveNeed('grass_block', 'birch_sapling')).toBeNull()
    expect(groveNeed('stone', 'air')).toBeNull()
  })
})
