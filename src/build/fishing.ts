/**
 * Where the court fishes (survival): open water near home with dry ground to stand on beside
 * it. Pure functions over block names, testable without a world.
 */
import type { BlockNames } from './hall'

export interface FishingSpot {
  /** The block of water to cast at (its surface). */
  water: [number, number, number]
  /** Where the fisher stands: feet on this spot, on the shore. */
  stand: [number, number, number]
}

const WATER = /^(water|flowing_water)$/
const AIR =
  /^(air|short_grass|tall_grass|fern|large_fern|snow_layer|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip)$/
/** Ground a fisher may stand on. */
const SHORE =
  /^(grass_block|dirt|coarse_dirt|podzol|sand|red_sand|gravel|stone|andesite|diorite|granite|clay|mud|sandstone|cobblestone)$/

/** Water at the surface, open to the sky, with water all round it (a pond, not a puddle). */
function openWater(names: BlockNames, x: number, y: number, z: number): boolean {
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) {
      if (!WATER.test(names(x + dx, y, z + dz) ?? '')) return false
      if (!AIR.test(names(x + dx, y + 1, z + dz) ?? '')) return false
    }
  return true
}

/** Dry ground with room for a player above it. */
function standable(names: BlockNames, x: number, y: number, z: number): boolean {
  return (
    SHORE.test(names(x, y - 1, z) ?? '') &&
    AIR.test(names(x, y, z) ?? '') &&
    AIR.test(names(x, y + 1, z) ?? '')
  )
}

/**
 * The nearest open water within `reach` of home (the surface within eight blocks of home's
 * height) with a shore spot two to four blocks from it, so a cast lands in the water.
 */
export function chooseFishingSpot(
  names: BlockNames,
  home: { x: number; y: number; z: number },
  reach = 64
): FishingSpot | undefined {
  const options: Array<{ spot: FishingSpot; far: number }> = []
  for (let dx = -reach; dx <= reach; dx += 1)
    for (let dz = -reach; dz <= reach; dz += 1) {
      const far = Math.hypot(dx, dz)
      if (far > reach) continue
      const x = home.x + dx
      const z = home.z + dz
      for (let y = home.y + 8; y >= home.y - 8; y--) {
        if (!WATER.test(names(x, y, z) ?? '')) continue
        if (!openWater(names, x, y, z)) break
        const stand = shoreNear(names, x, y, z)
        if (stand) options.push({ spot: { water: [x, y, z], stand }, far })
        break
      }
    }
  return options.sort((a, b) => a.far - b.far)[0]?.spot
}

/** A dry spot on the shore two to four blocks from the water, at the water's height or one up. */
function shoreNear(
  names: BlockNames,
  x: number,
  y: number,
  z: number
): [number, number, number] | undefined {
  for (let r = 2; r <= 4; r++)
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ])
      for (const dy of [1, 2])
        if (standable(names, x + dx, y + dy, z + dz)) return [x + dx, y + dy, z + dz]
  return undefined
}
