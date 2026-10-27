import type { Blueprint } from './blueprints'
import { rotate } from './blueprints'

export interface Point {
  x: number
  y: number
  z: number
}

/** What the site finder needs to know about a block. */
export type BlockKind =
  /** Empty: can be built into. */
  | 'air'
  /** Grass, ferns, snow layers: a placed block simply replaces them. */
  | 'replaceable'
  /** Solid ground or a full block. */
  | 'solid'
  /** Solid ground that flowers grow on (grass, dirt, podzol...). */
  | 'soil'
  /** Anything we must not build over or into: logs, leaves, water, lava, chests, doors... */
  | 'other'

export interface WorldView {
  /** undefined when the chunk is not loaded. */
  kind(x: number, y: number, z: number): BlockKind | undefined
}

export interface Zone {
  center: Point
  radius: number
}

export interface SiteOptions {
  /** Build as close to this point as possible (a player's feet, or a chosen spot). */
  near: Point
  /** Turn the front of the build toward this point (usually the person who asked). */
  faceToward?: Point
  /** Players' feet positions: never build on top of anyone. */
  avoid: Point[]
  /** Never build outside this zone. */
  zone?: Zone
  /** How far (blocks) from `near` to look for a spot. */
  searchRadius?: number
  /** Most foundation blocks a column may need where the ground dips. */
  maxFill?: number
  /** Keep this many blocks between the build and `near` (negative: allow building on it). */
  minDistance?: number
}

export interface Site {
  /** World position of the blueprint's (0, 0, 0) cell, after rotation. */
  origin: Point
  /** The blueprint as rotated for this site. */
  blueprint: Blueprint
  quarterTurns: number
  /** Foundation blocks to place first where the ground is lower than the build's floor. */
  fill: Point[]
}

const SCAN_UP = 8
const SCAN_DOWN = 10

/** Height of the ground surface (the top solid block) in a column, or null if not buildable. */
function surface(
  world: WorldView,
  x: number,
  z: number,
  aroundY: number
): { y: number; soil: boolean } | null {
  for (let y = aroundY + SCAN_UP; y >= aroundY - SCAN_DOWN; y--) {
    const kind = world.kind(x, y, z)
    if (kind === undefined) return null
    if (kind === 'air' || kind === 'replaceable') continue
    if (kind === 'solid' || kind === 'soil') return { y, soil: kind === 'soil' }
    return null // trees, water, lava, containers...
  }
  return null
}

/** Which way the build's front (its z = 0 side) should face to look toward `target`. */
export function turnsToFace(center: Point, target: Point | undefined): number {
  if (!target) return 0
  const dx = target.x - center.x
  const dz = target.z - center.z
  // Unrotated, the front faces -z. Each clockwise quarter turn moves it to +x, +z, -x.
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3
  return dz > 0 ? 2 : 0
}

function spiral(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++) out.push([dx, dz])
  return out.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2))
}

/**
 * Find the nearest spot where the blueprint fits without breaking anything: every cell is air or
 * replaceable, the ground under it is solid (soil for gardens) and nearly flat, nobody stands
 * there, and the whole build is inside the zone.
 */
export function findSite(bp: Blueprint, world: WorldView, opts: SiteOptions): Site | null {
  const maxFill = opts.maxFill ?? 2
  const minDistance = opts.minDistance ?? 2
  for (const [dx, dz] of spiral(opts.searchRadius ?? 24)) {
    const cx = Math.floor(opts.near.x) + dx
    const cz = Math.floor(opts.near.z) + dz
    const turns = turnsToFace({ x: cx, y: 0, z: cz }, opts.faceToward)
    const rotated = rotate(bp, turns)
    const ox = cx - Math.floor(rotated.size.x / 2)
    const oz = cz - Math.floor(rotated.size.z / 2)

    // Keep clear of the person asking and of everyone else.
    const inside = (p: Point, margin: number) =>
      p.x >= ox - margin &&
      p.x < ox + rotated.size.x + margin &&
      p.z >= oz - margin &&
      p.z < oz + rotated.size.z + margin
    if (minDistance >= 0 && inside(opts.near, minDistance)) continue
    if (opts.avoid.some((p) => inside(p, 1))) continue

    if (opts.zone) {
      const { center, radius } = opts.zone
      const corners = [
        [ox, oz],
        [ox + rotated.size.x - 1, oz],
        [ox, oz + rotated.size.z - 1],
        [ox + rotated.size.x - 1, oz + rotated.size.z - 1],
      ]
      if (corners.some(([x, z]) => Math.hypot(x - center.x, z - center.z) > radius)) continue
    }

    // The floor sits one above the highest ground under the bottom layer; lower columns get fill.
    const bottom = rotated.cells.filter((c) => c.y === 0)
    const ground = new Map<string, { y: number; soil: boolean } | null>()
    for (const c of bottom) {
      const key = `${c.x},${c.z}`
      if (!ground.has(key))
        ground.set(key, surface(world, ox + c.x, oz + c.z, Math.floor(opts.near.y)))
    }
    const columns = [...ground.values()]
    if (columns.some((g) => g === null)) continue
    if (bp.needsSoil && columns.some((g) => !g?.soil)) continue
    const floor = Math.max(...columns.map((g) => g!.y)) + 1
    if (columns.some((g) => floor - 1 - g!.y > (bp.needsSoil ? 0 : maxFill))) continue

    const fill: Point[] = []
    for (const [key, g] of ground) {
      const [x, z] = key.split(',').map(Number)
      for (let y = g!.y + 1; y < floor; y++) fill.push({ x: ox + x, y, z: oz + z })
    }

    const free = (x: number, y: number, z: number) => {
      const kind = world.kind(x, y, z)
      return kind === 'air' || kind === 'replaceable'
    }
    if (!rotated.cells.every((c) => free(ox + c.x, floor + c.y, oz + c.z))) continue
    if (!fill.every((p) => free(p.x, p.y, p.z))) continue

    return { origin: { x: ox, y: floor, z: oz }, blueprint: rotated, quarterTurns: turns, fill }
  }
  return null
}
