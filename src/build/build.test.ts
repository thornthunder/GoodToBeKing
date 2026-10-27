import { describe, expect, it } from 'vitest'
import {
  BLUEPRINT_IDS,
  makeBlueprint,
  matchBlueprint,
  rotate,
  spellbookList,
  type Blueprint,
} from './blueprints'
import { choosePalette, coloursIn } from './palette'
import { findSite, turnsToFace, type BlockKind, type WorldView } from './site'

/** A flat grass world at ground y = 69, optionally with obstacles. */
function flatWorld(
  obstacles: Array<[number, number, number, BlockKind]> = [],
  groundAt = 69
): WorldView {
  const extra = new Map(obstacles.map(([x, y, z, k]) => [`${x},${y},${z}`, k]))
  return {
    kind(x, y, z) {
      const special = extra.get(`${x},${y},${z}`)
      if (special) return special
      if (y < groundAt) return 'solid'
      if (y === groundAt) return 'soil'
      return 'air'
    },
  }
}

const cellKeys = (bp: Blueprint) => new Set(bp.cells.map((c) => `${c.x},${c.y},${c.z}`))

describe('blueprints', () => {
  it('every blueprint has unique cells inside its size', () => {
    for (const id of BLUEPRINT_IDS) {
      const bp = makeBlueprint(id)
      expect(cellKeys(bp).size).toBe(bp.cells.length)
      for (const c of bp.cells) {
        expect(c.x).toBeGreaterThanOrEqual(0)
        expect(c.x).toBeLessThan(bp.size.x)
        expect(c.y).toBeLessThan(bp.size.y)
        expect(c.z).toBeLessThan(bp.size.z)
      }
    }
  })

  it('the castle has a gate in the front wall and about 300 blocks', () => {
    const castle = makeBlueprint('castle')
    const keys = cellKeys(castle)
    expect(keys.has('5,0,0')).toBe(false) // the gate
    expect(keys.has('5,3,0')).toBe(true) // the lintel over it
    expect(keys.has('5,0,10')).toBe(true) // back wall is closed
    expect(castle.cells.length).toBeGreaterThan(250)
    expect(castle.cells.length).toBeLessThan(350)
  })

  it('matches requests to builds', () => {
    expect(matchBlueprint('can you build me a castle')).toBe('castle')
    expect(matchBlueprint('a tall tower please')).toBe('tower')
    expect(matchBlueprint('make a flower garden')).toBe('garden')
    expect(matchBlueprint('build a gate')).toBe('arch')
    expect(matchBlueprint('build a house')).toBeNull()
    expect(spellbookList()).toContain('a simple castle')
  })

  it('rotates around the footprint and back', () => {
    const arch = makeBlueprint('arch')
    const once = rotate(arch, 1)
    expect(once.size).toEqual({ x: 1, y: 6, z: 5 })
    expect(cellKeys(rotate(arch, 4))).toEqual(cellKeys(arch))
    expect(cellKeys(rotate(once, 3))).toEqual(cellKeys(arch))
  })
})

describe('palette', () => {
  it('reads colours in the order they are named', () => {
    expect(coloursIn('a pink and blue tower').map((c) => c.solid)).toEqual([
      'pink_concrete',
      'blue_concrete',
    ])
  })

  it('prefers the request, then remembered favourites, then the default', () => {
    const remembered = ['The Princess likes the colour magenta.', 'The Princess loves periwinkle.']
    expect(choosePalette('tower', 'a red tower', remembered).primary).toBe('red_concrete')
    const fromMemory = choosePalette('tower', 'a tower', remembered)
    expect(fromMemory.primary).toBe('magenta_concrete')
    expect(fromMemory.accent).toBe('light_blue_concrete')
    expect(choosePalette('garden', 'flowers', remembered).flowers).toEqual([
      'allium',
      'blue_orchid',
    ])
    expect(choosePalette('castle', 'a castle', []).primary).toBe('stone_bricks')
  })
})

describe('findSite', () => {
  const near = { x: 100, y: 70, z: 100 }

  it('finds a flat spot near the person, facing them, keeping clear of them', () => {
    const site = findSite(makeBlueprint('tower'), flatWorld(), {
      near,
      faceToward: near,
      avoid: [near],
    })
    expect(site).not.toBeNull()
    expect(site!.origin.y).toBe(70)
    expect(site!.fill).toEqual([])
    const { origin, blueprint } = site!
    const insideX = near.x >= origin.x - 2 && near.x < origin.x + blueprint.size.x + 2
    const insideZ = near.z >= origin.z - 2 && near.z < origin.z + blueprint.size.z + 2
    expect(insideX && insideZ).toBe(false)
  })

  it('never builds into a tree or over water', () => {
    const obstacles: Array<[number, number, number, BlockKind]> = []
    for (let x = 90; x < 110; x++)
      for (let z = 90; z < 110; z++) obstacles.push([x, 70, z, 'other'])
    const site = findSite(makeBlueprint('arch'), flatWorld(obstacles), {
      near,
      avoid: [],
      searchRadius: 14,
    })
    expect(site).not.toBeNull()
    const { origin, blueprint } = site!
    const overlaps =
      origin.x < 110 &&
      origin.x + blueprint.size.x > 90 &&
      origin.z < 110 &&
      origin.z + blueprint.size.z > 90
    expect(overlaps).toBe(false)
  })

  /** Flat ground at 69 with one hole of the given depth at (99, 100). */
  const holeWorld = (depth: number): WorldView => ({
    kind: (x, y, z) => (y <= (x === 99 && z === 100 ? 69 - depth : 69) ? 'solid' : 'air'),
  })
  const atHole = { near: { x: 99, y: 70, z: 100 }, avoid: [], searchRadius: 0, minDistance: -1 }

  it('fills a shallow dip under the build with foundation blocks', () => {
    const site = findSite(makeBlueprint('tower'), holeWorld(1), atHole)
    expect(site).not.toBeNull()
    expect(site!.origin.y).toBe(70)
    expect(site!.fill).toEqual([{ x: 99, y: 69, z: 100 }])
  })

  it('does not build over a deep hole', () => {
    expect(findSite(makeBlueprint('tower'), holeWorld(4), atHole)).toBeNull()
  })

  it('stays inside the zone', () => {
    const site = findSite(makeBlueprint('castle'), flatWorld(), {
      near,
      avoid: [],
      zone: { center: { x: 200, y: 70, z: 200 }, radius: 50 },
    })
    expect(site).toBeNull()
  })

  it('turns the front toward the person', () => {
    const c = { x: 0, y: 0, z: 0 }
    expect(turnsToFace(c, { x: 0, y: 0, z: -10 })).toBe(0)
    expect(turnsToFace(c, { x: 10, y: 0, z: 0 })).toBe(1)
    expect(turnsToFace(c, { x: 0, y: 0, z: 10 })).toBe(2)
    expect(turnsToFace(c, { x: -10, y: 0, z: 0 })).toBe(3)
  })
})
