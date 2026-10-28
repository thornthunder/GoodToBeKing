import fs from 'node:fs'
import { compileDesign } from '../build/compile'
import { DEFAULT_STOREY_HEIGHT, type CastleDesign } from '../build/design'

/** A named spot someone can be sent to: free to stand in, with a floor underneath. */
export interface Place {
  /** "the throne room of the Great Castle" */
  name: string
  x: number
  y: number
  z: number
}

/** Blocks one can stand in. */
const PASSABLE = (block: string | undefined) =>
  !block || block === 'air' || block.endsWith('_carpet')

/** "the great hall", "the King's bedchamber"; a name that starts with someone's name keeps it: "Merlin's study". */
const the = (name: string) =>
  /^the /i.test(name)
    ? name
    : /^\w+'s\b/.test(name)
      ? name[0].toUpperCase() + name.slice(1)
      : `the ${name}`

/**
 * Every room of the castles, and each castle's courtyard, with a spot to stand in near the middle:
 * nothing planned there or above (furniture is avoided), and a floor below.
 */
export function castlePlaces(designs: CastleDesign[]): Place[] {
  const places: Place[] = []
  for (const design of designs) {
    const plan = compileDesign(design)
    const blocks = new Map<string, string>()
    for (const s of plan.sections)
      for (const c of s.cells) blocks.set(`${c.x},${c.y},${c.z}`, c.block)
    const h = design.storeyHeight ?? DEFAULT_STOREY_HEIGHT
    const { x: ox, z: oz } = design.area

    /** The free spot nearest the middle of a rectangle, standing on the floor at `floor`. */
    const spot = (x0: number, z0: number, x1: number, z1: number, floor: number) => {
      const mx = (x0 + x1) / 2
      const mz = (z0 + z1) / 2
      const cells: Array<{ x: number; z: number; d: number }> = []
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) cells.push({ x, z, d: (x - mx) ** 2 + (z - mz) ** 2 })
      cells.sort((a, b) => a.d - b.d)
      const free = cells.find(
        ({ x, z }) =>
          !PASSABLE(blocks.get(`${x},${floor},${z}`)) &&
          PASSABLE(blocks.get(`${x},${floor + 1},${z}`)) &&
          PASSABLE(blocks.get(`${x},${floor + 2},${z}`))
      )
      return free && { x: free.x, y: floor + 1, z: free.z }
    }

    for (const b of design.buildings) {
      for (const [k, storey] of b.storeys.entries()) {
        for (const r of storey.rooms) {
          const at = spot(
            ox + r.x + 1,
            oz + r.z + 1,
            ox + r.x + r.width - 2,
            oz + r.z + r.depth - 2,
            design.floorY + k * h
          )
          if (at) places.push({ name: `${the(r.name)} of ${design.name}`, ...at })
        }
      }
    }
    const yard = spot(
      ox + Math.floor(design.area.width / 2) - 3,
      oz + Math.floor(design.area.depth / 2) - 3,
      ox + Math.floor(design.area.width / 2) + 3,
      oz + Math.floor(design.area.depth / 2) + 3,
      design.floorY
    )
    if (yard) places.push({ name: `the courtyard of ${design.name}`, ...yard })
  }
  return places
}

/** The places of the castles in these design files; files that cannot be read are skipped. */
export function placesFromFiles(files: string[]): Place[] {
  const designs: CastleDesign[] = []
  for (const file of files) {
    try {
      designs.push(JSON.parse(fs.readFileSync(file, 'utf8')) as CastleDesign)
    } catch {
      // A missing design only means fewer places.
    }
  }
  return castlePlaces(designs)
}
