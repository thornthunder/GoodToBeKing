/**
 * Looks for open ground big enough for a castle: no player-made blocks (paths, houses, our own
 * builds), little water, and as little earth to move as possible. The overlord picks one of the
 * candidates; the numbers here are what it reasons with.
 */
import type { Rect } from './design'
import type { Zone } from './site'

/** The top block of a column, or null when the chunk is not loaded. */
export type TopAt = (x: number, z: number) => { y: number; name: string } | null

export interface SiteOption {
  /** World north-west corner and size. */
  area: Rect
  /** Suggested floor height (one above the typical ground). */
  floorY: number
  /** Blocks to dig away above the floor and to fill below it. */
  cut: number
  fill: number
  trees: number
  water: number
  /** Distance from the zone centre. */
  distance: number
  /** Which way from the zone centre, e.g. "north-west". */
  direction: string
}

const NATURAL_TOP =
  /^(sand|red_sand|gravel|dirt|coarse_dirt|grass_block|podzol|mycelium|clay|stone|sandstone|red_sandstone|andesite|diorite|granite|tuff|deepslate|snow|snow_layer|ice|moss_block|[a-z_]*_leaves|[a-z_]*_log|water|flowing_water)$/
const TREE = /_leaves$|_log$/
/** Blocks of open, natural ground required around a site. */
const BORDER = 8
const WATER = /water/

/** Plants and air are looked through when finding a column's top. */
export const SEE_THROUGH =
  /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|deadbush|dead_bush|vine|glow_lichen|sweet_berry_bush|bush|leaf_litter|firefly_bush|wildflowers|short_dry_grass|tall_dry_grass|poppy|dandelion|allium|cornflower|azure_bluet|oxeye_daisy|[a-z_]*_tulip|lily_of_the_valley|peony|rose_bush|lilac|sunflower|pink_petals|brown_mushroom|red_mushroom|sugar_cane|snow_layer)$/

function direction(dx: number, dz: number): string {
  if (Math.hypot(dx, dz) < 8) return 'right at the centre'
  const ns = dz < -Math.abs(dx) / 2 ? 'north' : dz > Math.abs(dx) / 2 ? 'south' : ''
  const ew = dx > Math.abs(dz) / 2 ? 'east' : dx < -Math.abs(dz) / 2 ? 'west' : ''
  return [ns, ew].filter(Boolean).join('-') || 'near the centre'
}

function grows(r: Rect, by: number): Rect {
  return { x: r.x - by, z: r.z - by, width: r.width + 2 * by, depth: r.depth + 2 * by }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.depth && b.z < a.z + a.depth
}

/**
 * The best few places for a castle of about `size` blocks square inside the zone, cheapest
 * first and not overlapping each other or anything in `avoid`.
 */
export function findCastleSites(
  topAt: TopAt,
  zone: Zone,
  opts: { sizes?: number[]; avoid?: Rect[]; count?: number; step?: number } = {}
): SiteOption[] {
  const sizes = opts.sizes ?? [36, 30, 26]
  const step = opts.step ?? 4
  const avoid = (opts.avoid ?? []).map((r) => grows(r, 4))
  const cache = new Map<string, ReturnType<TopAt>>()
  const top = (x: number, z: number) => {
    const k = `${x},${z}`
    if (!cache.has(k)) cache.set(k, topAt(x, z))
    return cache.get(k)!
  }
  const options: Array<SiteOption & { cost: number }> = []
  const r = zone.radius
  for (const size of sizes) {
    for (let x = zone.center.x - r; x <= zone.center.x + r - size; x += step) {
      for (let z = zone.center.z - r; z <= zone.center.z + r - size; z += step) {
        const area: Rect = { x, z, width: size, depth: size }
        const corners = [
          [x, z],
          [x + size - 1, z],
          [x, z + size - 1],
          [x + size - 1, z + size - 1],
        ]
        if (corners.some(([cx, cz]) => Math.hypot(cx - zone.center.x, cz - zone.center.z) > r))
          continue
        if (avoid.some((a) => overlaps(a, area))) continue
        const heights: number[] = []
        let trees = 0
        let water = 0
        let bad = false
        // Keep well away from anything players made (houses, paths, farms): a wide border.
        const m = BORDER
        for (let cx = x - m; cx < x + size + m && !bad; cx++) {
          for (let cz = z - m; cz < z + size + m; cz++) {
            const inside = cx >= x && cx < x + size && cz >= z && cz < z + size
            const t = top(cx, cz)
            if (!t) {
              if (inside) bad = true
              if (bad) break
              continue
            }
            if (!NATURAL_TOP.test(t.name)) {
              bad = true
              break
            }
            if (!inside) continue
            if (WATER.test(t.name)) water++
            else if (TREE.test(t.name)) trees++
            else heights.push(t.y)
          }
        }
        if (bad || water > size * size * 0.03 || heights.length < size * size * 0.5) continue
        heights.sort((a, b) => a - b)
        const ground = heights[Math.floor(heights.length / 2)]
        let cut = 0
        let fill = 0
        for (const h of heights) {
          if (h > ground) cut += h - ground
          else fill += ground - h
        }
        const cost = cut + fill + trees * 6 + water * 20
        const cx = x + size / 2 - zone.center.x
        const cz = z + size / 2 - zone.center.z
        options.push({
          area,
          floorY: ground + 1,
          cut,
          fill,
          trees,
          water,
          distance: Math.round(Math.hypot(cx, cz)),
          direction: direction(cx, cz),
          cost: cost / (size * size),
        })
      }
    }
  }
  // Bigger sites are worth a little more earth moving.
  options.sort((a, b) => a.cost - b.cost - (b.area.width - a.area.width) * 0.02)
  const chosen: SiteOption[] = []
  for (const o of options) {
    if (chosen.length >= (opts.count ?? 3)) break
    if (chosen.some((c) => overlaps(grows(c.area, 2), o.area))) continue
    const { cost: _cost, ...site } = o
    void _cost
    chosen.push(site)
  }
  return chosen
}
