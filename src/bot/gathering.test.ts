import { describe, expect, it } from 'vitest'
import { untouched, type BlockNames } from './gathering'

/** A small world: grass at y 64 over dirt, air above, plus whatever `extra` puts in. */
function world(extra: Record<string, string> = {}): BlockNames {
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (key in extra) return extra[key]
    if (y > 64) return 'air'
    return y === 64 ? 'grass_block' : 'dirt'
  }
}

describe('untouched land', () => {
  it('digs plain ground: grass in the surface, ground all round', () => {
    expect(untouched('dirt', world(), 10, 64, 10)).toBe(true)
    expect(untouched('dirt', world({ '10,65,10': 'short_grass' }), 10, 64, 10)).toBe(true)
  })

  it('never takes a wall, nor ground beside something someone made', () => {
    // A dirt wall standing on the grass: air on both sides.
    const wall = world({ '10,65,10': 'dirt', '10,66,10': 'dirt' })
    expect(untouched('dirt', wall, 10, 65, 10)).toBe(false)
    expect(untouched('dirt', wall, 10, 66, 10)).toBe(false)
    // Grass next to a plank floor, or under a torch.
    expect(untouched('dirt', world({ '11,64,10': 'oak_planks' }), 10, 64, 10)).toBe(false)
    expect(untouched('dirt', world({ '10,65,10': 'torch' }), 10, 64, 10)).toBe(false)
    // Ground with a hole beside it is not taken either: the bots never dig big pits.
    expect(untouched('dirt', world({ '9,64,10': 'air' }), 10, 64, 10)).toBe(false)
    // Nor the floor of a hole: that way a bot once dug itself a shaft six deep.
    expect(untouched('dirt', world({ '10,64,10': 'air' }), 10, 63, 10)).toBe(false)
  })

  it("never digs the court's hall: its floor is under a roof, its mended dirt among planks", () => {
    // Dirt floor under a plank roof four blocks up: not under open sky.
    expect(untouched('dirt', world({ '10,68,10': 'oak_planks' }), 10, 64, 10)).toBe(false)
    // Under a tree's leaves is still open ground.
    expect(untouched('dirt', world({ '10,69,10': 'oak_leaves' }), 10, 64, 10)).toBe(true)
    // A patch of dirt with a plank wall three blocks off, or a torch two blocks up.
    expect(untouched('dirt', world({ '13,65,10': 'oak_planks' }), 10, 64, 10)).toBe(false)
    expect(untouched('dirt', world({ '9,66,11': 'torch' }), 10, 64, 10)).toBe(false)
  })

  it('never digs the floor of a pit: the court once dug the land down into a quarry', () => {
    // A pit three wide and one deep: its middle has air all round above, but not two out.
    const pit: Record<string, string> = {}
    for (let x = 9; x <= 11; x++) for (let z = 9; z <= 11; z++) pit[`${x},64,${z}`] = 'air'
    expect(untouched('dirt', world(pit), 10, 63, 10)).toBe(false)
  })

  it('chops logs only from trees, with leaves close by', () => {
    const tree = world({ '5,65,5': 'oak_log', '5,66,5': 'oak_log', '5,68,6': 'oak_leaves' })
    expect(untouched('wood', tree, 5, 65, 5)).toBe(true)
    const cabin = world({ '5,65,5': 'oak_log', '5,66,5': 'oak_log', '6,65,5': 'oak_planks' })
    expect(untouched('wood', cabin, 5, 65, 5)).toBe(false)
  })
})
