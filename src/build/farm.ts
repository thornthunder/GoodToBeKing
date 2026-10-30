/**
 * The court's wheat field (survival): where it goes, and what each square needs. Pure functions
 * over block names, so they can be tested without a world.
 */
import type { BlockNames } from './hall'

export interface Farm {
  /** The soil's height: farmland sits at y, the wheat at y + 1. */
  y: number
  cells: Array<[number, number]>
  /** Near water (crops grow faster), or dry. */
  watered: boolean
}

/** What a square of the field needs right now. */
export type FarmNeed = 'fill' | 'till' | 'plant' | 'harvest' | null

const SOIL = /^(grass_block|dirt|coarse_dirt|rooted_dirt)$/
const COVER =
  /^(air|short_grass|tall_grass|fern|large_fern|snow_layer|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip)$/
const WATER = /^(water|flowing_water)$/
/** Wheat is ripe at growth 7. */
export const RIPE = 7
/** The field's size: four by four. */
const SIDE = 4

/**
 * A field of four by four on flat, untouched soil within `reach` of home: next to water when there
 * is any (farmland drinks from four blocks away), else dry; never within three blocks of the
 * hall's walls (a path stays free) nor where `taken` says something is.
 */
export function chooseFarm(
  names: BlockNames,
  home: { x: number; y: number; z: number },
  opts: { reach?: number; keepClear?: Array<[number, number]> } = {}
): Farm | undefined {
  const reach = opts.reach ?? 24
  const clear = opts.keepClear ?? []
  const options: Array<{ farm: Farm; score: number }> = []
  for (let dx = -reach; dx <= reach - SIDE; dx++)
    for (let dz = -reach; dz <= reach - SIDE; dz++) {
      const x0 = home.x + dx
      const z0 = home.z + dz
      // The soil height at the corner; the rest must match.
      const y = surface(names, x0, z0, home.y)
      if (y === undefined) continue
      const cells: Array<[number, number]> = []
      let ok = true
      for (let i = 0; i < SIDE && ok; i++)
        for (let j = 0; j < SIDE && ok; j++) {
          const x = x0 + i
          const z = z0 + j
          if (clear.some(([cx, cz]) => Math.abs(cx - x) <= 3 && Math.abs(cz - z) <= 3)) ok = false
          else if (!SOIL.test(names(x, y, z) ?? '') || !COVER.test(names(x, y + 1, z) ?? ''))
            ok = false
          else cells.push([x, z])
        }
      if (!ok) continue
      const watered = cells.some(([x, z]) => nearWater(names, x, y, z))
      // Watered first, then nearest to home.
      const far = Math.hypot(x0 + SIDE / 2 - home.x, z0 + SIDE / 2 - home.z)
      options.push({ farm: { y, cells, watered }, score: (watered ? 0 : 1000) + far })
    }
  return options.sort((a, b) => a.score - b.score)[0]?.farm
}

/** The largest the field grows to, plot by plot. */
export const MAX_FIELD = 64

/**
 * Another plot of four by four beside the field, at its height, on flat untouched soil clear of
 * `keepClear`: the field grows as its seeds multiply. Undefined when it is as big as it gets or
 * nothing fits beside it.
 */
export function extendFarm(
  names: BlockNames,
  farm: Farm,
  opts: { keepClear?: Array<[number, number]> } = {}
): Farm | undefined {
  if (farm.cells.length + SIDE * SIDE > MAX_FIELD) return undefined
  const clear = opts.keepClear ?? []
  const has = new Set(farm.cells.map(([x, z]) => `${x},${z}`))
  const xs = farm.cells.map(([x]) => x)
  const zs = farm.cells.map(([, z]) => z)
  const [minX, maxX, minZ, maxZ] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...zs),
    Math.max(...zs),
  ]
  // Corners of the plots that would touch the field along a side.
  const corners: Array<[number, number]> = []
  for (let z = minZ; z <= maxZ; z += SIDE) corners.push([maxX + 1, z], [minX - SIDE, z])
  for (let x = minX; x <= maxX; x += SIDE) corners.push([x, maxZ + 1], [x, minZ - SIDE])
  for (const [x0, z0] of corners) {
    const cells: Array<[number, number]> = []
    for (let i = 0; i < SIDE; i++) for (let j = 0; j < SIDE; j++) cells.push([x0 + i, z0 + j])
    const fits = cells.every(
      ([x, z]) =>
        !has.has(`${x},${z}`) &&
        !clear.some(([cx, cz]) => Math.abs(cx - x) <= 3 && Math.abs(cz - z) <= 3) &&
        SOIL.test(names(x, farm.y, z) ?? '') &&
        COVER.test(names(x, farm.y + 1, z) ?? '')
    )
    if (fits) return { ...farm, cells: [...farm.cells, ...cells] }
  }
  return undefined
}

/** The top soil block of a column near height `around` (with air or grass above it). */
function surface(names: BlockNames, x: number, z: number, around: number): number | undefined {
  for (let y = around + 3; y >= around - 4; y--)
    if (SOIL.test(names(x, y, z) ?? '') && COVER.test(names(x, y + 1, z) ?? '')) return y
  return undefined
}

function nearWater(names: BlockNames, x: number, y: number, z: number): boolean {
  for (let dx = -4; dx <= 4; dx++)
    for (let dz = -4; dz <= 4; dz++)
      if (
        WATER.test(names(x + dx, y, z + dz) ?? '') ||
        WATER.test(names(x + dx, y + 1, z + dz) ?? '')
      )
        return true
  return false
}

/**
 * What a square needs: soil (or dry farmland turned back to dirt) to till, bare farmland to
 * plant, ripe wheat to harvest, a hole where the soil was to fill; null when it is growing.
 */
export function farmNeed(
  soil: string | undefined,
  crop: string | undefined,
  growth?: number
): FarmNeed {
  if (crop === 'wheat') return (growth ?? 0) >= RIPE ? 'harvest' : null
  if (soil === 'farmland') return COVER.test(crop ?? 'air') ? 'plant' : null
  if (soil && SOIL.test(soil) && COVER.test(crop ?? 'air')) return 'till'
  // The square's soil dug out or blown away: dirt in first.
  if (soil && COVER.test(soil)) return 'fill'
  return null
}
