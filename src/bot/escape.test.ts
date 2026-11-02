import { describe, expect, it } from 'vitest'
import { Vec3 } from 'vec3'
import { directions, planStep, type Names } from './escape'

/**
 * A pit in level ground: grass at y 63 (feet at 64) everywhere but a hole three by three (x and
 * z 0 to 2) down to stone at y 59 (feet at 60).
 */
function pit(change: Record<string, string> = {}): Names {
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (key in change) return change[key]
    if (x >= 0 && x <= 2 && z >= 0 && z <= 2) return y <= 59 ? 'stone' : 'air'
    if (y > 63) return 'air'
    return y === 63 ? 'grass_block' : 'dirt'
  }
}

describe('climbing out of a hole', () => {
  it('digs a step up into the wall of the pit', () => {
    const step = planStep(pit(), new Vec3(2, 60, 1), { x: 1, z: 0 })
    expect(step?.stand).toEqual(new Vec3(3, 61, 1))
    expect(step?.dig).toEqual([new Vec3(3, 61, 1), new Vec3(3, 62, 1)])
  })

  it('clears the block over its head too, to have room to jump', () => {
    const low = pit({ '2,62,1': 'dirt' })
    const step = planStep(low, new Vec3(2, 60, 1), { x: 1, z: 0 })
    expect(step?.dig).toEqual([new Vec3(2, 62, 1), new Vec3(3, 61, 1), new Vec3(3, 62, 1)])
  })

  it('walks along level ground without digging', () => {
    const step = planStep(pit(), new Vec3(1, 60, 1), { x: 1, z: 0 })
    expect(step).toEqual({ stand: new Vec3(2, 60, 1), dig: [] })
  })

  it('does not go where the ground drops away', () => {
    expect(planStep(pit({ '2,59,1': 'air' }), new Vec3(1, 60, 1), { x: 1, z: 0 })).toBeNull()
  })

  it('never digs through what someone made, nor what it cannot see', () => {
    expect(
      planStep(pit({ '3,61,1': 'cobblestone' }), new Vec3(2, 60, 1), { x: 1, z: 0 })
    ).toBeNull()
    expect(planStep(pit({ '3,62,1': 'oak_planks' }), new Vec3(2, 60, 1), { x: 1, z: 0 })).toBeNull()
    const blind: Names = (x, y, z) => (x === 3 && y === 61 ? undefined : pit()(x, y, z))
    expect(planStep(blind, new Vec3(2, 60, 1), { x: 1, z: 0 })).toBeNull()
  })

  it('reaches the surface in four steps from four blocks down', () => {
    const names = pit()
    let at = new Vec3(2, 60, 1)
    for (let i = 0; i < 4; i++) {
      const step = planStep(names, at, { x: 1, z: 0 })
      if (!step) throw new Error(`no step at ${at}`)
      at = step.stand
    }
    expect(at).toEqual(new Vec3(6, 64, 1))
  })

  it('tries the way most towards the goal first, its opposite last', () => {
    expect(directions(new Vec3(0, 60, 0), { x: 10, z: 3 })).toEqual([
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 },
      { x: -1, z: 0 },
    ])
    expect(directions(new Vec3(0, 60, 0), { x: -2, z: -9 })).toEqual([
      { x: 0, z: -1 },
      { x: -1, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
    ])
  })
})
