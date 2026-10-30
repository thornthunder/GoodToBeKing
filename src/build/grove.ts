/**
 * The court's grove (survival): saplings planted near home, felled when grown and planted again,
 * so wood comes from home instead of from trees ever further off. Where it goes and what each
 * spot needs: pure functions over block names, testable without a world.
 */
import type { BlockNames } from './hall'

export interface Grove {
  /** Where each tree grows: x, the soil's height (the sapling stands one above), z. */
  spots: Array<[number, number, number]>
}

/** What a spot of the grove needs right now. */
export type GroveNeed = 'fell' | 'plant' | null

const SOIL = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt)$/
const COVER =
  /^(air|short_grass|tall_grass|fern|large_fern|snow_layer|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip|bush)$/
const LOG = /_log$/
export const SAPLING = /_sapling$/
/** How many trees the grove has. */
const TREES = 6
/** Trees this far apart (in x or z) do not crowd each other's leaves. */
const SPACING = 5
/** A tree needs this much open air above its sapling to grow. */
const HEADROOM = 8
/** Never this close to the hall or the field (a tree's leaves spread two blocks round it). */
const CLEAR = 6

/**
 * Up to six spots on open soil between 8 and `reach` blocks from home, five apart, near home's
 * height, with room above to grow and clear of the hall and the field; nearest home first. None
 * when fewer than three fit.
 */
export function chooseGrove(
  names: BlockNames,
  home: { x: number; y: number; z: number },
  opts: { reach?: number; keepClear?: Array<[number, number]> } = {}
): Grove | undefined {
  const reach = opts.reach ?? 32
  const clear = opts.keepClear ?? []
  const options: Array<{ spot: [number, number, number]; far: number }> = []
  for (let dx = -reach; dx <= reach; dx++)
    for (let dz = -reach; dz <= reach; dz++) {
      const far = Math.hypot(dx, dz)
      if (far < 8 || far > reach) continue
      const x = home.x + dx
      const z = home.z + dz
      if (clear.some(([cx, cz]) => Math.abs(cx - x) < CLEAR && Math.abs(cz - z) < CLEAR)) continue
      const y = surface(names, x, z, home.y)
      if (y === undefined || Math.abs(y - home.y) > 4) continue
      if (!roomToGrow(names, x, y, z)) continue
      options.push({ spot: [x, y, z], far })
    }
  const spots: Array<[number, number, number]> = []
  for (const { spot } of options.sort((a, b) => a.far - b.far)) {
    if (spots.length >= TREES) break
    const [x, , z] = spot
    if (spots.some(([sx, , sz]) => Math.abs(sx - x) < SPACING && Math.abs(sz - z) < SPACING))
      continue
    spots.push(spot)
  }
  return spots.length >= 3 ? { spots } : undefined
}

/** The top soil block of a column near height `around` (with air or grass above it). */
function surface(names: BlockNames, x: number, z: number, around: number): number | undefined {
  for (let y = around + 4; y >= around - 5; y--)
    if (SOIL.test(names(x, y, z) ?? '') && COVER.test(names(x, y + 1, z) ?? '')) return y
  return undefined
}

/** Open air above the spot, and nothing built or growing right next to it. */
function roomToGrow(names: BlockNames, x: number, y: number, z: number): boolean {
  for (let dy = 1; dy <= HEADROOM; dy++) if (!COVER.test(names(x, y + dy, z) ?? '')) return false
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      for (let dy = 1; dy <= 3; dy++)
        if (!COVER.test(names(x + dx, y + dy, z + dz) ?? '')) return false
  return true
}

/** A grown tree (its trunk on the spot) to fell, bare soil to plant; null while it grows. */
export function groveNeed(soil: string | undefined, above: string | undefined): GroveNeed {
  if (LOG.test(above ?? '')) return 'fell'
  if (SAPLING.test(above ?? '')) return null
  if (SOIL.test(soil ?? '') && COVER.test(above ?? 'air')) return 'plant'
  return null
}
