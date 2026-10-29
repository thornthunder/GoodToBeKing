/**
 * Turns a CastleDesign into a Plan: every block with its world position, grouped into sections
 * (work orders) that one bot can build on its own, with the order they depend on. Sections that
 * stand on the ground also own their columns: they clear natural blocks above the floor and fill
 * gaps under it down to solid ground.
 */
import { makeBlueprint } from './blueprints'
import {
  DEFAULT_MATERIALS,
  DEFAULT_STOREY_HEIGHT,
  type BuildingDesign,
  type CastleDesign,
  type Materials,
  type Opening,
  type Rect,
  type RoomType,
  type Side,
} from './design'
import { furnish, type Placement } from './rooms'

export type Vec = [number, number, number]

export interface PlanCell {
  x: number
  y: number
  z: number
  block: string
  /** Item data value (bed colour). */
  data?: number
  /** Place against the neighbour in this direction (ladders, wall torches). */
  against?: Vec
  /** Stand on this side when placing (sets the facing of beds, chests, furnaces). */
  from?: Side
  /** Appears by itself when another cell is placed (the head of a bed). */
  auto?: boolean
  /** `air` cells only: break whatever block stands there (only ever our own earlier work). */
  remove?: boolean
}

/** A column the section prepares: natural blocks above `top` are cleared, gaps up to `top` filled. */
export interface FillColumn {
  x: number
  z: number
  top: number
  material: string
  /** Material of the top fill block, when different (paving under an open floor). */
  topMaterial?: string
}

export type SectionKind = 'wall' | 'tower' | 'storey' | 'courtyard' | 'features' | 'repair'

export interface Section {
  id: string
  /** For chat: "the kitchen and the great hall". */
  title: string
  kind: SectionKind
  cells: PlanCell[]
  columns: FillColumn[]
  /** Ids of sections that must be finished first. */
  after: string[]
  /** Workers this section is meant for, if the design says. */
  crew?: string[]
}

export interface Plan {
  id: string
  title: string
  floorY: number
  /** World rectangle of the whole castle. */
  area: Rect
  sections: Section[]
  /** Highest block of the plan. */
  top: number
  /** Every planned block by "x,y,z" (so clearing never digs up our own work). */
  planned: Map<string, string>
}

/** Sections with more cells than this are split so several bots can share the work. */
export const MAX_SECTION_CELLS = 420

const STEP: Record<Side, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
}

interface Owner {
  id: string
  title: string
  kind: SectionKind
  after: string[]
  /** Storey sections of one building, so the next storey can wait for every part of this one. */
  group?: string
  crew?: string[]
  order: number
}

interface Entry {
  cell: PlanCell
  owner: string
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** "Keep" -> "the keep"; "the King's bedchamber" and "Merlin's tower" stay as they are. */
function titled(name: string): string {
  return /^(the|a|an)\s/i.test(name) || /^[A-Z]/.test(name) ? name : `the ${name}`
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** Cells of an opening along a rectangle's side, as world (x, z) pairs. */
function openingCells(r: Rect, o: Opening, ox: number, oz: number): Array<[number, number]> {
  const width = o.width ?? 1
  const out: Array<[number, number]> = []
  for (let i = 0; i < width; i++) {
    const t = o.at + i
    switch (o.side) {
      case 'north':
        out.push([ox + r.x + t, oz + r.z])
        break
      case 'south':
        out.push([ox + r.x + t, oz + r.z + r.depth - 1])
        break
      case 'west':
        out.push([ox + r.x, oz + r.z + t])
        break
      case 'east':
        out.push([ox + r.x + r.width - 1, oz + r.z + t])
        break
    }
  }
  return out
}

function onEdge(r: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number) {
  return x === r.x0 || x === r.x1 || z === r.z0 || z === r.z1
}

class Canvas {
  readonly cells = new Map<string, Entry>()
  readonly owners = new Map<string, Owner>()
  private order = 0

  owner(
    id: string,
    title: string,
    kind: SectionKind,
    after: string[] = [],
    group?: string,
    crew?: string[]
  ): string {
    if (!this.owners.has(id))
      this.owners.set(id, { id, title, kind, after, group, crew, order: this.order++ })
    return id
  }

  set(
    owner: string,
    x: number,
    y: number,
    z: number,
    block: string,
    extra: Partial<PlanCell> = {}
  ) {
    this.cells.set(key(x, y, z), { cell: { x, y, z, block, ...extra }, owner })
  }

  get(x: number, y: number, z: number): Entry | undefined {
    return this.cells.get(key(x, y, z))
  }

  removeColumn(x: number, z: number): void {
    for (const k of [...this.cells.keys()]) {
      const [cx, , cz] = k.split(',').map(Number)
      if (cx === x && cz === z) this.cells.delete(k)
    }
  }
}

export function compileDesign(design: CastleDesign): Plan {
  const m: Materials = { ...DEFAULT_MATERIALS, ...design.materials }
  const h = design.storeyHeight ?? DEFAULT_STOREY_HEIGHT
  const fy = design.floorY
  const ox = design.area.x
  const oz = design.area.z
  const W = design.area.width
  const D = design.area.depth
  const c = new Canvas()
  const solids: Rect[] = [
    ...(design.towers ?? []).map((t) => ({ x: t.x, z: t.z, width: t.size, depth: t.size })),
    ...design.buildings,
    ...(design.existing ?? []),
  ]
  const inSolid = (lx: number, lz: number) =>
    solids.some((r) => lx >= r.x && lx < r.x + r.width && lz >= r.z && lz < r.z + r.depth)

  // 1. Courtyard paving over the whole area (buildings and walls draw over it).
  const yard = c.owner('courtyard', 'the courtyard paving', 'courtyard')
  for (let lx = 0; lx < W; lx++)
    for (let lz = 0; lz < D; lz++) c.set(yard, ox + lx, fy, oz + lz, m.paving)

  // 2. The curtain wall around the edge, with merlons on top.
  const wallHeight = design.wallHeight ?? 6
  const sideOf = (lx: number, lz: number): Side =>
    lz === 0 ? 'north' : lz === D - 1 ? 'south' : lx === 0 ? 'west' : 'east'
  let perimeterIndex = 0
  const perimeter: Array<[number, number]> = []
  for (let lx = 0; lx < W; lx++) perimeter.push([lx, 0])
  for (let lz = 1; lz < D; lz++) perimeter.push([W - 1, lz])
  for (let lx = W - 2; lx >= 0; lx--) perimeter.push([lx, D - 1])
  for (let lz = D - 2; lz >= 1; lz--) perimeter.push([0, lz])
  for (const [lx, lz] of perimeter) {
    const side = sideOf(lx, lz)
    const owner = c.owner(`wall-${side}`, `the ${side} curtain wall`, 'wall')
    for (let y = fy; y < fy + wallHeight; y++) c.set(owner, ox + lx, y, oz + lz, m.wall)
    if (perimeterIndex++ % 2 === 0) c.set(owner, ox + lx, fy + wallHeight, oz + lz, m.wall)
  }
  for (const g of design.gates ?? []) {
    const owner = `wall-${g.side}`
    for (const [x, z] of openingCells(
      { x: 0, z: 0, width: W, depth: D },
      { width: 3, ...g },
      ox,
      oz
    ))
      for (let y = fy + 1; y <= fy + (g.height ?? 3); y++) c.set(owner, x, y, z, 'air')
  }

  // 3. Towers: hollow, with a ladder to a capped top, merlons and a lantern.
  for (const t of design.towers ?? []) {
    const owner = c.owner(`tower-${slug(t.name)}`, titled(t.name), 'tower')
    const x0 = ox + t.x
    const z0 = oz + t.z
    const x1 = x0 + t.size - 1
    const z1 = z0 + t.size - 1
    const r = { x0, z0, x1, z1 }
    const doorCells = new Set(
      (t.doors ?? []).flatMap((d) =>
        openingCells({ x: t.x, z: t.z, width: t.size, depth: t.size }, d, ox, oz).map(
          ([x, z]) => `${x},${z}`
        )
      )
    )
    const top = fy + t.height
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const edge = onEdge(r, x, z)
        c.set(owner, x, fy, z, edge ? m.wall : m.floor)
        for (let y = fy + 1; y < top; y++) {
          const door = edge && doorCells.has(`${x},${z}`) && y <= fy + 2
          c.set(owner, x, y, z, edge && !door ? m.wall : 'air')
        }
        c.set(owner, x, top, z, m.roof)
        const corner = (x === x0 || x === x1) && (z === z0 || z === z1)
        const middle =
          (x === Math.floor((x0 + x1) / 2) && (z === z0 || z === z1)) ||
          (z === Math.floor((z0 + z1) / 2) && (x === x0 || x === x1))
        if (corner || middle) c.set(owner, x, top + 1, z, m.wall)
        else if (!edge) c.set(owner, x, top + 1, z, 'air')
      }
    c.set(owner, Math.floor((x0 + x1) / 2), top + 1, Math.floor((z0 + z1) / 2), m.light)
    // Ladder in an inner corner, against a wall without a door.
    const ladder = towerLadder(r, doorCells)
    for (let y = fy + 1; y <= top; y++)
      c.set(owner, ladder.x, y, ladder.z, 'ladder', { against: ladder.against })
  }

  // 4. Buildings, storey by storey.
  for (const b of design.buildings) drawBuilding(c, design, b, m, h, inSolid)

  // 5. Courtyard features.
  if (design.features?.length) {
    const owner = c.owner('features', 'the courtyard gardens and lamps', 'features', ['courtyard'])
    const flowers = [
      'allium',
      'cornflower',
      'oxeye_daisy',
      'pink_tulip',
      'azure_bluet',
      'lily_of_the_valley',
    ]
    for (const f of design.features) {
      const x0 = ox + f.x
      const z0 = oz + f.z
      if (f.type === 'lamp') {
        c.set(owner, x0, fy + 1, z0, 'stone_brick_wall')
        c.set(owner, x0, fy + 2, z0, 'stone_brick_wall')
        c.set(owner, x0, fy + 3, z0, m.light)
      } else if (f.type === 'garden') {
        let i = 0
        for (let x = x0; x < x0 + (f.width ?? 3); x++)
          for (let z = z0; z < z0 + (f.depth ?? 3); z++) {
            c.set(owner, x, fy, z, 'grass_block')
            c.set(owner, x, fy + 1, z, flowers[i++ % flowers.length])
          }
      } else if (f.type === 'well') {
        for (let x = x0; x < x0 + 3; x++)
          for (let z = z0; z < z0 + 3; z++) {
            const centre = x === x0 + 1 && z === z0 + 1
            const corner = (x === x0 || x === x0 + 2) && (z === z0 || z === z0 + 2)
            c.set(owner, x, fy, z, centre ? 'cobblestone' : m.paving)
            if (!centre) c.set(owner, x, fy + 1, z, 'cobblestone')
            if (corner) {
              c.set(owner, x, fy + 2, z, 'spruce_fence')
              c.set(owner, x, fy + 3, z, 'spruce_fence')
            }
            c.set(owner, x, fy + 4, z, 'spruce_planks')
          }
        c.set(owner, x0 + 1, fy + 1, z0 + 1, 'cauldron')
      }
    }
  }

  // 6. Existing builds: leave their footprint alone, then repair them in their own section.
  const repairs: Array<{ id: string; cells: PlanCell[]; columns: FillColumn[] }> = []
  for (const e of design.existing ?? []) {
    for (let x = ox + e.x; x < ox + e.x + e.width; x++)
      for (let z = oz + e.z; z < oz + e.z + e.depth; z++) c.removeColumn(x, z)
    const id = c.owner(`repair-${slug(e.name)}`, `the foundations of ${e.name}`, 'repair')
    repairs.push({ id, ...repairExisting(e, ox, oz, fy, m) })
  }
  for (const k of design.keepOut ?? [])
    for (let x = ox + k.x; x < ox + k.x + k.width; x++)
      for (let z = oz + k.z; z < oz + k.z + k.depth; z++) c.removeColumn(x, z)

  return toPlan(design, c, repairs, m)
}

function towerLadder(
  r: { x0: number; z0: number; x1: number; z1: number },
  doors: Set<string>
): { x: number; z: number; against: Vec } {
  const options: Array<{ x: number; z: number; against: Vec; wall: [number, number] }> = [
    { x: r.x0 + 1, z: r.z0 + 1, against: [0, 0, -1], wall: [r.x0 + 1, r.z0] },
    { x: r.x1 - 1, z: r.z0 + 1, against: [0, 0, -1], wall: [r.x1 - 1, r.z0] },
    { x: r.x0 + 1, z: r.z1 - 1, against: [0, 0, 1], wall: [r.x0 + 1, r.z1] },
    { x: r.x1 - 1, z: r.z1 - 1, against: [0, 0, 1], wall: [r.x1 - 1, r.z1] },
  ]
  const ok = options.find((o) => !doors.has(`${o.wall[0]},${o.wall[1]}`))
  return ok ?? options[0]
}

function drawBuilding(
  c: Canvas,
  design: CastleDesign,
  b: BuildingDesign,
  m: Materials,
  h: number,
  inSolid: (lx: number, lz: number) => boolean
): void {
  const fy = design.floorY
  const ox = design.area.x
  const oz = design.area.z
  const x0 = ox + b.x
  const z0 = oz + b.z
  const x1 = x0 + b.width - 1
  const z1 = z0 + b.depth - 1
  const r = { x0, z0, x1, z1 }
  const n = b.storeys.length
  const roofY = fy + n * h
  const base = slug(b.name)
  const group = `b-${base}`

  // The ladder: against whichever outer wall it touches.
  let ladder: { x: number; z: number; against: Vec } | undefined
  if (b.ladder && n > 1) {
    const lx = ox + b.ladder.x
    const lz = oz + b.ladder.z
    const against: Vec =
      lx === x0 + 1
        ? [-1, 0, 0]
        : lx === x1 - 1
          ? [1, 0, 0]
          : lz === z0 + 1
            ? [0, 0, -1]
            : [0, 0, 1]
    ladder = { x: lx, z: lz, against }
  }
  const ladderWall = ladder ? `${ladder.x + ladder.against[0]},${ladder.z + ladder.against[2]}` : ''
  const isLadder = (x: number, z: number) =>
    ladder !== undefined && ladder.x === x && ladder.z === z

  const outerDoors = new Map<string, number>()
  for (const d of b.doors ?? [])
    for (const [x, z] of openingCells(b, d, ox, oz))
      outerDoors.set(`${x},${z}`, Math.min(3, d.height ?? 2))

  for (let k = 0; k < n; k++) {
    const yk = fy + k * h
    const rooms = b.storeys[k].rooms.map((room) => ({
      room,
      x0: ox + room.x,
      z0: oz + room.z,
      x1: ox + room.x + room.width - 1,
      z1: oz + room.z + room.depth - 1,
    }))
    const names = rooms.map((rm) => titled(rm.room.name))
    const sameName = names.length === 1 && slug(names[0]) === base
    const what = sameName ? titled(b.name) : `${listWords(names)} of ${titled(b.name)}`
    const title = k === 0 ? what : `${what} (storey ${k + 1})`
    const owner = c.owner(
      `${group}-s${k + 1}`,
      title,
      'storey',
      k > 0 ? [`${group}-s${k}`] : [],
      group,
      b.crew
    )

    // Floor layer, outer walls, interior air.
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const edge = onEdge(r, x, z)
        if (!(k > 0 && isLadder(x, z))) c.set(owner, x, yk, z, edge ? m.wall : m.floor)
        for (let y = yk + 1; y < yk + h; y++) c.set(owner, x, y, z, edge ? m.wall : 'air')
      }
    // Partitions along room edges inside the building.
    const partition = new Set<string>()
    for (const rm of rooms)
      for (let x = rm.x0; x <= rm.x1; x++)
        for (let z = rm.z0; z <= rm.z1; z++) {
          if (!onEdge(rm, x, z) || onEdge(r, x, z)) continue
          partition.add(`${x},${z}`)
          for (let y = yk + 1; y < yk + h; y++) c.set(owner, x, y, z, m.partition)
        }
    // Outer doors on the ground storey (first: they decide which way rooms face).
    const doorways: Array<[number, number]> = []
    if (k === 0)
      for (const [cellKey, height] of outerDoors) {
        const [x, z] = cellKey.split(',').map(Number)
        doorways.push([x, z])
        for (let y = yk + 1; y <= yk + height; y++) c.set(owner, x, y, z, 'air')
      }
    // Doorways where two rooms meet.
    for (let i = 0; i < rooms.length; i++)
      for (let j = i + 1; j < rooms.length; j++) {
        const shared = sharedEdge(rooms[i], rooms[j])
        if (shared.length < 3) continue
        const inner = shared.slice(1, -1).filter(([x, z]) => !onEdge(r, x, z) && !isLadder(x, z))
        if (!inner.length) continue
        const mid = inner[Math.floor(inner.length / 2)]
        const cells = inner.length >= 7 ? [mid, inner[Math.floor(inner.length / 2) - 1]] : [mid]
        for (const [x, z] of cells) {
          doorways.push([x, z])
          for (let y = yk + 1; y <= yk + 2; y++) c.set(owner, x, y, z, 'air')
        }
      }

    // Windows in outer walls that face the open air.
    for (const [x, z, out] of outerWallCells(r)) {
      const lx = x - ox + out[0]
      const lz = z - oz + out[1]
      const corner = (x - x0 <= 1 || x1 - x <= 1) && (z - z0 <= 1 || z1 - z <= 1)
      const along = out[0] === 0 ? x - x0 : z - z0
      if (corner || along % 3 !== 2) continue
      if (k === 0 && outerDoors.has(`${x},${z}`)) continue
      if (`${x},${z}` === ladderWall) continue
      if (
        inSolid(lx, lz) &&
        !(lx < 0 || lz < 0 || lx >= design.area.width || lz >= design.area.depth)
      )
        continue
      const inward: [number, number] = [x - out[0], z - out[1]]
      if (partition.has(`${inward[0]},${inward[1]}`)) continue
      const roomType = rooms.find(
        (rm) => inward[0] >= rm.x0 && inward[0] <= rm.x1 && inward[1] >= rm.z0 && inward[1] <= rm.z1
      )?.room.type
      const glass = windowGlass(roomType, along, m.window)
      for (let y = yk + 2; y <= Math.min(yk + 3, yk + h - 2); y++) c.set(owner, x, y, z, glass)
    }

    // Furniture, room by room.
    for (const rm of rooms) {
      const inner = { x0: rm.x0 + 1, z0: rm.z0 + 1, x1: rm.x1 - 1, z1: rm.z1 - 1 }
      const keepFree = new Set<string>()
      let doorSide: Side | undefined
      for (const [dx, dz] of doorways) {
        for (const [sx, sz, side] of [
          [dx, dz + 1, 'north'],
          [dx, dz - 1, 'south'],
          [dx + 1, dz, 'west'],
          [dx - 1, dz, 'east'],
        ] as Array<[number, number, Side]>) {
          if (sx < inner.x0 || sx > inner.x1 || sz < inner.z0 || sz > inner.z1) continue
          keepFree.add(`${sx},${sz}`)
          const [fx, fz] = STEP[opposite(side)]
          keepFree.add(`${sx + fx},${sz + fz}`)
          doorSide ??= side
        }
      }
      if (ladder) {
        keepFree.add(`${ladder.x},${ladder.z}`)
        keepFree.add(`${ladder.x - ladder.against[0]},${ladder.z - ladder.against[2]}`)
      }
      furnish({
        type: rm.room.type as RoomType,
        name: rm.room.name,
        ...inner,
        y: yk + 1,
        height: h - 1,
        doorSide: rm.room.honour ? opposite(rm.room.honour) : (doorSide ?? 'south'),
        blocked: (x, z) => keepFree.has(`${x},${z}`),
        put: (x, dy, z, p: Placement) =>
          c.set(owner, x, yk + 1 + dy, z, p.block, {
            ...(p.data !== undefined ? { data: p.data } : {}),
            ...(p.from ? { from: p.from } : {}),
            ...(p.auto ? { auto: true } : {}),
          }),
      })
    }

    // The ladder through this storey (its floor is the hole the ladder passes through).
    if (ladder) {
      const fromY = k === 0 ? yk + 1 : yk
      for (let y = fromY; y < yk + h; y++)
        c.set(owner, ladder.x, y, ladder.z, 'ladder', { against: ladder.against })
    }
  }

  // Roof with merlons and corner lanterns (part of the top storey's work).
  const owner = `${group}-s${n}`
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      if (isLadder(x, z)) c.set(owner, x, roofY, z, 'ladder', { against: ladder!.against })
      else c.set(owner, x, roofY, z, m.roof)
    }
  let i = 0
  for (const [x, z] of outerWallCells(r)) {
    const corner = (x === x0 || x === x1) && (z === z0 || z === z1)
    if (corner || i++ % 2 === 0) c.set(owner, x, roofY + 1, z, m.wall)
    if (corner) c.set(owner, x, roofY + 2, z, m.light)
  }
}

function opposite(s: Side): Side {
  return s === 'north' ? 'south' : s === 'south' ? 'north' : s === 'east' ? 'west' : 'east'
}

function windowGlass(type: RoomType | undefined, i: number, plain: string): string {
  if (type === 'chapel') return i % 2 ? 'yellow_stained_glass_pane' : 'blue_stained_glass_pane'
  if (type === 'princess_bedchamber') return 'magenta_stained_glass_pane'
  if (type === 'wizard_study') return 'purple_stained_glass_pane'
  if (type === 'throne_room') return i % 2 ? 'red_stained_glass_pane' : plain
  return plain
}

/** Perimeter cells of a rectangle (corners once) with the outward direction of their side. */
function outerWallCells(r: {
  x0: number
  z0: number
  x1: number
  z1: number
}): Array<[number, number, [number, number]]> {
  const out: Array<[number, number, [number, number]]> = []
  for (let x = r.x0; x <= r.x1; x++) out.push([x, r.z0, [0, -1]])
  for (let z = r.z0 + 1; z <= r.z1; z++) out.push([r.x1, z, [1, 0]])
  for (let x = r.x1 - 1; x >= r.x0; x--) out.push([x, r.z1, [0, 1]])
  for (let z = r.z1 - 1; z > r.z0; z--) out.push([r.x0, z, [-1, 0]])
  return out
}

/** World cells two room rectangles share along an edge, in order. */
function sharedEdge(
  a: { x0: number; z0: number; x1: number; z1: number },
  b: { x0: number; z0: number; x1: number; z1: number }
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (a.x1 === b.x0 || b.x1 === a.x0) {
    const x = a.x1 === b.x0 ? a.x1 : a.x0
    for (let z = Math.max(a.z0, b.z0); z <= Math.min(a.z1, b.z1); z++) out.push([x, z])
  } else if (a.z1 === b.z0 || b.z1 === a.z0) {
    const z = a.z1 === b.z0 ? a.z1 : a.z0
    for (let x = Math.max(a.x0, b.x0); x <= Math.min(a.x1, b.x1); x++) out.push([x, z])
  }
  return out
}

/**
 * An existing spellbook build becomes part of the castle: foundations under its walls down to
 * the ground, its courtyard filled flat to its own floor, and optionally a back gate.
 */
function repairExisting(
  e: NonNullable<CastleDesign['existing']>[number],
  ox: number,
  oz: number,
  floorY: number,
  m: Materials
): { cells: PlanCell[]; columns: FillColumn[] } {
  const bp = makeBlueprint(e.blueprint)
  const wx = ox + e.x
  const wz = oz + e.z
  const bottom = new Set(
    bp.cells.filter((cell) => cell.y === 0).map((cell) => `${cell.x},${cell.z}`)
  )
  const wallBlock = bp.cells.find((cell) => cell.y === 0)?.block ?? m.wall
  const columns: FillColumn[] = []
  for (let x = 0; x < bp.size.x; x++)
    for (let z = 0; z < bp.size.z; z++) {
      const wall = bottom.has(`${x},${z}`)
      columns.push({
        x: wx + x,
        z: wz + z,
        top: e.y - 1,
        material: wall ? wallBlock : 'dirt',
        ...(wall ? {} : { topMaterial: m.paving }),
      })
    }
  const cells: PlanCell[] = []
  if (e.openBack) {
    // The front gate is a gap in the bottom layers of the z = 0 wall; open the same gap at the back.
    const back = bp.size.z - 1
    const at = (x: number, y: number, z: number) =>
      bp.cells.some((cell) => cell.x === x && cell.y === y && cell.z === z)
    for (let x = 1; x < bp.size.x - 1; x++) {
      const gate =
        !at(x, 0, 0) && bp.cells.some((cell) => cell.x === x && cell.z === 0 && cell.y > 0)
      if (!gate) continue
      for (let y = 0; y < bp.size.y && !at(x, y, 0); y++)
        if (at(x, y, back))
          cells.push({ x: wx + x, y: e.y + y, z: wz + back, block: 'air', remove: true })
      // A step down outside the new gate.
      columns.push({
        x: wx + x,
        z: wz + back + 1,
        top: Math.min(floorY, e.y - 2),
        material: 'dirt',
        topMaterial: m.wall,
      })
    }
    const light = bp.cells.find((cell) => cell.z === 0 && cell.block === 'lantern')
    if (light) cells.push({ x: wx + light.x, y: e.y + light.y, z: wz + back, block: m.light })
  }
  return { cells, columns }
}

function toPlan(
  design: CastleDesign,
  c: Canvas,
  repairs: Array<{ id: string; cells: PlanCell[]; columns: FillColumn[] }>,
  m: Materials
): Plan {
  const fy = design.floorY
  const byOwner = new Map<string, PlanCell[]>()
  const planned = new Map<string, string>()
  let top = fy
  for (const [k, { cell, owner }] of c.cells) {
    if (cell.block !== 'air') {
      planned.set(k, cell.block)
      top = Math.max(top, cell.y)
    }
    if (cell.block === 'air' && !cell.remove) continue
    if (!byOwner.has(owner)) byOwner.set(owner, [])
    byOwner.get(owner)!.push(cell)
  }
  // Columns belong to whoever owns the floor layer there.
  const columnsByOwner = new Map<string, FillColumn[]>()
  for (let x = design.area.x; x < design.area.x + design.area.width; x++)
    for (let z = design.area.z; z < design.area.z + design.area.depth; z++) {
      const entry = c.get(x, fy, z)
      if (!entry) continue
      const wallLike = entry.cell.block === m.wall || entry.cell.block === m.partition
      const col: FillColumn = { x, z, top: fy - 1, material: wallLike ? m.foundation : 'dirt' }
      if (!columnsByOwner.has(entry.owner)) columnsByOwner.set(entry.owner, [])
      columnsByOwner.get(entry.owner)!.push(col)
    }
  for (const r of repairs) {
    byOwner.set(r.id, r.cells)
    columnsByOwner.set(r.id, r.columns)
    for (const cell of r.cells)
      if (cell.block !== 'air') planned.set(key(cell.x, cell.y, cell.z), cell.block)
  }

  const owners = [...c.owners.values()].sort((a, b) => a.order - b.order)
  const sections: Section[] = []
  const partsOf = new Map<string, string[]>()
  for (const o of owners) {
    const cells = byOwner.get(o.id) ?? []
    const columns = columnsByOwner.get(o.id) ?? []
    if (!cells.length && !columns.length) continue
    const parts = split(o, cells, columns)
    partsOf.set(
      o.id,
      parts.map((p) => p.id)
    )
    sections.push(...parts)
  }
  // Wait for every part of the sections named in `after`.
  for (const s of sections) s.after = s.after.flatMap((id) => partsOf.get(id) ?? [])
  // Part order within the plan: ground work first, then by storey.
  const rank = (s: Section) =>
    s.kind === 'features' ? 9 : s.kind === 'storey' ? Number(/-s(\d+)/.exec(s.id)?.[1] ?? 1) : 0
  sections.sort((a, b) => rank(a) - rank(b))
  return {
    id: slug(design.name),
    title: design.name,
    floorY: fy,
    area: design.area,
    sections,
    top,
    planned,
  }
}

const SPLIT_NAMES = ['west', 'middle', 'east']
const SPLIT_NAMES_Z = ['north', 'middle', 'south']

/** Split a big owner into parts along its longer horizontal axis. */
function split(o: Owner, cells: PlanCell[], columns: FillColumn[]): Section[] {
  const total = cells.length + columns.length
  const parts = Math.min(3, Math.ceil(total / MAX_SECTION_CELLS))
  const whole: Section = {
    id: o.id,
    title: o.title,
    kind: o.kind,
    cells,
    columns,
    after: o.after,
    ...(o.crew ? { crew: o.crew } : {}),
  }
  if (parts <= 1 || o.kind === 'repair') return [whole]
  const xs = [...cells.map((cell) => cell.x), ...columns.map((col) => col.x)]
  const zs = [...cells.map((cell) => cell.z), ...columns.map((col) => col.z)]
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanZ = Math.max(...zs) - Math.min(...zs)
  const axis: 'x' | 'z' = spanX >= spanZ ? 'x' : 'z'
  const lo = axis === 'x' ? Math.min(...xs) : Math.min(...zs)
  const span = (axis === 'x' ? spanX : spanZ) + 1
  const partOf = (v: number) => Math.min(parts - 1, Math.floor(((v - lo) * parts) / span))
  const names =
    parts === 2
      ? axis === 'x'
        ? ['west', 'east']
        : ['north', 'south']
      : axis === 'x'
        ? SPLIT_NAMES
        : SPLIT_NAMES_Z
  // Keep a bed's two cells together: the head goes with its foot.
  const footOf = new Map<string, number>()
  for (const cell of cells)
    if (cell.block === 'bed' && !cell.auto)
      footOf.set(`${cell.x},${cell.y},${cell.z}`, partOf(cell[axis]))
  const out: Section[] = []
  for (let p = 0; p < parts; p++) {
    out.push({
      id: `${o.id}-p${p + 1}`,
      title: `the ${names[p]} part of ${o.title}`,
      kind: o.kind,
      cells: [],
      columns: columns.filter((col) => partOf(col[axis]) === p),
      after: o.after,
      ...(o.crew ? { crew: o.crew } : {}),
    })
  }
  for (const cell of cells) {
    let p = partOf(cell[axis])
    if (cell.auto) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const foot = footOf.get(`${cell.x + dx},${cell.y},${cell.z + dz}`)
        if (foot !== undefined) p = foot
      }
    }
    out[p].cells.push(cell)
  }
  return out.filter((s) => s.cells.length || s.columns.length)
}
