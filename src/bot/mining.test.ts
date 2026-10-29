import { describe, expect, it } from 'vitest'
import { chooseMine, stepAt, stepCells, type Mine } from './mining'

describe("the court's mine", () => {
  const mine: Mine = { x: 10, y: 65, z: 0, dx: 1, dz: 0, steps: 0 }

  it('goes down one for every step forward, two high, with headroom to step down', () => {
    expect(stepAt(mine, 3)).toMatchObject({ x: 13, y: 62, z: 0 })
    expect(stepCells(mine, 1).map((v) => v.y)).toEqual([66, 65, 64])
    // Past the depth limit it goes on level, two high.
    expect(stepAt(mine, 30).y).toBe(65 - 18)
    expect(stepCells(mine, 30)).toHaveLength(2)
  })

  it('starts on open soil 10 to 24 blocks from home, away from the hall', () => {
    const flat = (x: number, y: number) => (y < 64 ? 'dirt' : y === 64 ? 'grass_block' : 'air')
    const start = chooseMine((x, y) => flat(x, y), { x: 0, y: 65, z: 0 }, [[0, 0]])
    expect(start).toMatchObject({ y: 65, steps: 0 })
    expect(Math.hypot(start!.x, start!.z)).toBeGreaterThanOrEqual(10)
  })
})
