import { describe, expect, it } from 'vitest'
import {
  BRANCH_LENGTH,
  branchAt,
  branchCount,
  branchStart,
  chooseMine,
  lastSpot,
  mineGoesOn,
  NEW_DEPTH,
  stepAt,
  stepCells,
  type Mine,
} from './mining'

describe("the court's mine", () => {
  const mine: Mine = { x: 10, y: 65, z: 0, dx: 1, dz: 0, steps: 0 }

  it('goes down one for every step forward, two high, with headroom to step down', () => {
    expect(stepAt(mine, 3)).toMatchObject({ x: 13, y: 62, z: 0 })
    expect(stepCells(mine, 1).map((v) => v.y)).toEqual([66, 65, 64])
    // Past the depth limit it goes on level, two high.
    expect(stepAt(mine, 30).y).toBe(65 - 18)
    expect(stepCells(mine, 30)).toHaveLength(2)
  })

  it('branches off its level tunnel right and left in turn, every four steps', () => {
    // Going east (+x) at depth 18: the level tunnel runs at y 47.
    expect(branchStart(mine, 0)).toBe(22)
    expect(branchStart(mine, 1)).toBe(22)
    expect(branchStart(mine, 2)).toBe(26)
    expect(branchAt(mine, 0, 3)).toMatchObject({ x: 32, y: 47, z: 3 })
    expect(branchAt(mine, 1, 3)).toMatchObject({ x: 32, y: 47, z: -3 })
    expect(branchAt(mine, 0, BRANCH_LENGTH)?.z).toBe(BRANCH_LENGTH)
    // Forty steps of level tunnel: ten pairs of branches, none past its end.
    expect(branchCount(mine)).toBe(20)
    expect(branchStart(mine, 20)).toBeUndefined()
    // Where the miner goes on from.
    expect(lastSpot({ ...mine, steps: 30 })).toMatchObject({ x: 40, y: 47 })
    expect(lastSpot({ ...mine, steps: 58, branch: 3, branchSteps: 5 })).toMatchObject({
      x: 36,
      z: -5,
    })
  })

  it('lets an old mine stopped at its length branch off the tunnel it has; others end', () => {
    const old: Mine = { ...mine, steps: 80, ended: 'long enough' }
    expect(mineGoesOn(old)).toBe(true)
    expect(old.ended).toBeUndefined()
    expect(branchCount(old)).toBe(30)
    expect(mineGoesOn({ ...mine, steps: 12, ended: 'water' })).toBe(false)
    expect(mineGoesOn({ ...mine, steps: 90, branch: 29, ended: 'worked out' })).toBe(false)
  })

  it('starts on open soil 10 to 24 blocks from home, away from the hall', () => {
    const flat = (x: number, y: number) => (y < 64 ? 'dirt' : y === 64 ? 'grass_block' : 'air')
    const start = chooseMine((x, y) => flat(x, y), { x: 0, y: 65, z: 0 }, [[0, 0]])
    expect(start).toMatchObject({ y: 65, steps: 0, depth: NEW_DEPTH })
    expect(Math.hypot(start!.x, start!.z)).toBeGreaterThanOrEqual(10)
  })

  it('starts on a forest floor too, and looks further out and to the sides when it must', () => {
    // Leaf litter on the grass everywhere; the four ways out to 24 blocks are all kept clear.
    const forest = (x: number, y: number) =>
      y < 64 ? 'dirt' : y === 64 ? 'grass_block' : y === 65 ? 'leaf_litter' : 'air'
    const home = { x: 0, y: 65, z: 0 }
    expect(chooseMine((x, y) => forest(x, y), home, [[0, 0]])).toMatchObject({ y: 65 })
    const ways: Array<[number, number]> = []
    for (let r = 10; r <= 24; r += 2) ways.push([r, 0], [-r, 0], [0, r], [0, -r])
    const far = chooseMine((x, y) => forest(x, y), home, ways)
    expect(far).toBeDefined()
    expect(Math.hypot(far!.x, far!.z)).toBeGreaterThan(10)
    // Off to the side of a way kept clear, never on it.
    expect(ways.some(([x, z]) => Math.abs(x - far!.x) <= 5 && Math.abs(z - far!.z) <= 5)).toBe(
      false
    )
  })
})
