/**
 * Furniture for each room type, made of plain blocks a player could place: tables are planks
 * with a carpet, benches are slabs, a throne is a gold block with a back. Directional blocks
 * (beds, chests, furnaces, lecterns) carry `from`: the side the builder stands on when placing
 * them, which sets the way they face.
 */
import type { RoomType, Side } from './design'

export interface Placement {
  block: string
  data?: number
  from?: Side
  /** Placed by the game together with another cell (the head of a bed). */
  auto?: boolean
}

export interface RoomSpace {
  type: RoomType
  name: string
  /** Interior, world coordinates, inclusive. */
  x0: number
  z0: number
  x1: number
  z1: number
  /** First air layer above the floor. */
  y: number
  /** Air layers available. */
  height: number
  /** The wall the main way in is on (furniture of honour goes opposite). */
  doorSide: Side
  /** Cells to keep free on the floor (in front of doors, at the ladder). */
  blocked(x: number, z: number): boolean
  put(x: number, dy: number, z: number, p: Placement): void
}

const OPPOSITE: Record<Side, Side> = { north: 'south', south: 'north', east: 'west', west: 'east' }
const STEP: Record<Side, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
}

/** Bed colours (the bed item's data value). */
const BED = { white: 0, magenta: 2, lightBlue: 3, purple: 10, blue: 11, brown: 12, green: 13, red: 14 }

/** A helper bound to one room: tracks used floor cells so pieces never land on each other. */
class Room {
  private readonly used = new Set<string>()
  constructor(readonly s: RoomSpace) {}

  get w(): number {
    return this.s.x1 - this.s.x0 + 1
  }
  get d(): number {
    return this.s.z1 - this.s.z0 + 1
  }

  inside(x: number, z: number): boolean {
    return x >= this.s.x0 && x <= this.s.x1 && z >= this.s.z0 && z <= this.s.z1
  }

  free(x: number, z: number): boolean {
    return this.inside(x, z) && !this.s.blocked(x, z) && !this.used.has(`${x},${z}`)
  }

  /** Put a piece on the floor (dy 0) and optionally more on top; marks the cell used. */
  put(x: number, z: number, layers: Array<Placement | null>): boolean {
    if (!this.free(x, z)) return false
    this.used.add(`${x},${z}`)
    layers.forEach((p, dy) => {
      if (p && dy < this.s.height) this.s.put(x, dy, z, p)
    })
    return true
  }

  /** Two-cell bed: foot at (x, z), head one step toward `headTo`. */
  bed(x: number, z: number, headTo: Side, data: number): boolean {
    const [dx, dz] = STEP[headTo]
    const hx = x + dx
    const hz = z + dz
    if (!this.free(x, z) || !this.free(hx, hz)) return false
    this.used.add(`${x},${z}`)
    this.used.add(`${hx},${hz}`)
    this.s.put(x, 0, z, { block: 'bed', data, from: OPPOSITE[headTo] })
    this.s.put(hx, 0, hz, { block: 'bed', data, auto: true })
    return true
  }

  /** Cells along the inside of a wall, in order, optionally leaving the ends free. */
  wall(side: Side, margin = 0): Array<[number, number]> {
    const { x0, x1, z0, z1 } = this.s
    const out: Array<[number, number]> = []
    if (side === 'north' || side === 'south') {
      const z = side === 'north' ? z0 : z1
      for (let x = x0 + margin; x <= x1 - margin; x++) out.push([x, z])
    } else {
      const x = side === 'west' ? x0 : x1
      for (let z = z0 + margin; z <= z1 - margin; z++) out.push([x, z])
    }
    return out
  }

  /** The row `n` cells in from a wall (0 = against it). */
  row(side: Side, n: number, margin = 0): Array<[number, number]> {
    const [dx, dz] = STEP[OPPOSITE[side]]
    return this.wall(side, margin).map(([x, z]) => [x + dx * n, z + dz * n])
  }

  /** Long walls of the room (the pair with more cells). */
  get longSides(): [Side, Side] {
    return this.w >= this.d ? ['north', 'south'] : ['west', 'east']
  }

  get shortSides(): [Side, Side] {
    return this.w >= this.d ? ['west', 'east'] : ['north', 'south']
  }

  corners(): Array<[number, number]> {
    const { x0, x1, z0, z1 } = this.s
    return [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ]
  }

  /** Light the corners that are still free. */
  lightCorners(light = 'lantern'): void {
    for (const [x, z] of this.corners()) this.put(x, z, [{ block: light }])
  }

  /** Cover every free floor cell with carpet. */
  carpet(block: string): void {
    for (let x = this.s.x0; x <= this.s.x1; x++)
      for (let z = this.s.z0; z <= this.s.z1; z++) this.put(x, z, [{ block }])
  }

  /** A line of cells from the door side to the far side through the middle (an aisle). */
  aisle(width: number): Array<[number, number]> {
    const { x0, x1, z0, z1 } = this.s
    const out: Array<[number, number]> = []
    const along = this.s.doorSide === 'north' || this.s.doorSide === 'south'
    if (along) {
      const mid = Math.floor((x0 + x1) / 2)
      const from = mid - Math.floor((width - 1) / 2)
      for (let z = z0; z <= z1; z++)
        for (let x = from; x < from + width; x++) if (x >= x0 && x <= x1) out.push([x, z])
    } else {
      const mid = Math.floor((z0 + z1) / 2)
      const from = mid - Math.floor((width - 1) / 2)
      for (let x = x0; x <= x1; x++)
        for (let z = from; z < from + width; z++) if (z >= z0 && z <= z1) out.push([x, z])
    }
    return out
  }
}

function table(r: Room, cells: Array<[number, number]>, cloth = 'white_carpet', every = 4): void {
  cells.forEach(([x, z], i) =>
    r.put(x, z, [{ block: 'spruce_planks' }, { block: i % every === 1 ? 'lantern' : cloth }])
  )
}

function benches(r: Room, cells: Array<[number, number]>): void {
  for (const [x, z] of cells) r.put(x, z, [{ block: 'spruce_slab' }])
}

/** A long table down the middle with benches on both sides. */
function feastTables(r: Room): void {
  const [a] = r.longSides
  const across = a === 'north' ? r.d : r.w
  const rows = across >= 9 ? [Math.floor(across / 3), across - 1 - Math.floor(across / 3)] : [Math.floor(across / 2)]
  for (const n of rows) {
    table(r, r.row(a, n, 2))
    benches(r, r.row(a, n - 1, 2))
    benches(r, r.row(a, n + 1, 2))
  }
}

function hearth(r: Room, side: Side): void {
  const cells = r.wall(side, 1)
  const mid = Math.floor(cells.length / 2)
  const [cx, cz] = cells[mid]
  const [lx, lz] = cells[mid - 1] ?? cells[mid]
  const [rx, rz] = cells[mid + 1] ?? cells[mid]
  if (!r.free(cx, cz) || !r.free(lx, lz) || !r.free(rx, rz)) return
  r.put(lx, lz, [{ block: 'brick_block' }, { block: 'brick_block' }, { block: 'brick_block' }])
  r.put(rx, rz, [{ block: 'brick_block' }, { block: 'brick_block' }, { block: 'brick_block' }])
  r.put(cx, cz, [{ block: 'campfire' }, null, { block: 'brick_block' }])
}

function along(r: Room, side: Side, blocks: Array<Placement[]>, margin = 1): void {
  let i = 0
  for (const [x, z] of r.wall(side, margin)) {
    if (i >= blocks.length) break
    if (r.put(x, z, blocks[i])) i++
  }
}

const FURNISH: Record<RoomType, (r: Room) => void> = {
  great_hall(r) {
    const far = OPPOSITE[r.s.doorSide]
    hearth(r, r.longSides.find((s) => s !== r.s.doorSide) ?? r.longSides[0])
    // The high table across the far end.
    table(r, r.row(far, 1, 2), 'red_carpet', 3)
    feastTables(r)
    r.lightCorners()
  },
  dining_hall(r) {
    feastTables(r)
    r.lightCorners()
  },
  throne_room(r) {
    const far = OPPOSITE[r.s.doorSide]
    // A dais two deep along the far wall with two thrones: gold for the King, amethyst for the Princess.
    const back = r.row(far, 0, 1)
    const front = r.row(far, 1, 1)
    const mid = Math.floor(back.length / 2)
    const seats: Array<[number, string]> = [
      [mid - 1, 'gold_block'],
      [mid + 1, 'amethyst_block'],
    ]
    for (const [i, block] of seats) {
      const [bx, bz] = back[i]
      const [fx, fz] = front[i]
      r.put(bx, bz, [{ block: 'quartz_block' }, { block }, { block }])
      r.put(fx, fz, [{ block: 'quartz_block' }, { block }])
    }
    const [lx, lz] = back[mid]
    r.put(lx, lz, [{ block: 'quartz_block' }, { block: 'lantern' }])
    for (const [x, z] of [...back, ...front]) r.put(x, z, [{ block: 'quartz_block' }])
    for (const [x, z] of r.aisle(r.w >= 7 && r.d >= 7 ? 3 : 1)) r.put(x, z, [{ block: 'red_carpet' }])
    // Pillars along the long walls, one in from them.
    for (const side of r.longSides)
      r.row(side, 1, 2).forEach(([x, z], i) => {
        if (i % 4 === 0) r.put(x, z, Array.from({ length: r.s.height }, () => ({ block: 'quartz_pillar' })))
      })
    r.lightCorners()
  },
  kitchen(r) {
    const far = OPPOSITE[r.s.doorSide]
    const facing = r.s.doorSide
    const stoves: Placement[][] = []
    for (let i = 0; i < 6; i++) stoves.push([{ block: i % 2 ? 'smoker' : 'furnace', from: facing }])
    stoves.splice(2, 0, [{ block: 'campfire' }])
    along(r, far, stoves)
    const [s1, s2] = r.shortSides
    along(r, s1, [[{ block: 'cauldron' }], [{ block: 'crafting_table' }], [{ block: 'barrel' }, { block: 'barrel' }]])
    along(r, s2, [[{ block: 'barrel' }, { block: 'barrel' }], [{ block: 'barrel' }], [{ block: 'composter' }]])
    const [cx, cz] = [Math.floor((r.s.x0 + r.s.x1) / 2), Math.floor((r.s.z0 + r.s.z1) / 2)]
    table(r, [[cx - 1, cz], [cx, cz], [cx + 1, cz]], 'white_carpet', 2)
    r.lightCorners()
  },
  pantry(r) {
    FURNISH.storeroom(r)
  },
  storeroom(r) {
    const goods = ['barrel', 'hay_block', 'pumpkin', 'melon_block', 'barrel', 'chest']
    for (const side of ['north', 'south', 'east', 'west'] as Side[]) {
      r.wall(side, 1).forEach(([x, z], i) => {
        const g = goods[i % goods.length]
        if (g === 'chest') r.put(x, z, [{ block: 'chest', from: OPPOSITE[side] }])
        else r.put(x, z, [{ block: g }, i % 2 ? null : { block: 'barrel' }])
      })
    }
    r.lightCorners()
  },
  royal_bedchamber(r) {
    chamber(r, BED.red, 'red_carpet', [[{ block: 'bookshelf' }, { block: 'lantern' }], [{ block: 'chest', from: r.s.doorSide }], [{ block: 'gold_block' }, { block: 'lantern' }]])
  },
  princess_bedchamber(r) {
    chamber(r, BED.magenta, 'magenta_carpet', [
      [{ block: 'bookshelf' }, { block: 'lantern' }],
      [{ block: 'chest', from: r.s.doorSide }],
      [{ block: 'spruce_planks' }, { block: 'cake' }],
      [{ block: 'jukebox' }],
      [{ block: 'amethyst_block' }, { block: 'lantern' }],
    ])
  },
  bedchamber(r) {
    chamber(r, BED.blue, 'light_blue_carpet', [[{ block: 'bookshelf' }, { block: 'lantern' }], [{ block: 'chest', from: r.s.doorSide }], [{ block: 'lectern', from: r.s.doorSide }]])
  },
  apprentices_chamber(r) {
    beds(r, 2, BED.brown)
    along(r, r.s.doorSide === 'north' ? 'south' : 'north', [[{ block: 'chest', from: r.s.doorSide }], [{ block: 'crafting_table' }], [{ block: 'chest', from: r.s.doorSide }]])
    r.lightCorners()
    r.carpet('brown_carpet')
  },
  barracks(r) {
    beds(r, 4, BED.red)
    along(r, r.shortSides[0], [[{ block: 'chest', from: OPPOSITE[r.shortSides[0]] }], [{ block: 'barrel' }]])
    r.lightCorners()
  },
  guardroom(r) {
    const [cx, cz] = [Math.floor((r.s.x0 + r.s.x1) / 2), Math.floor((r.s.z0 + r.s.z1) / 2)]
    table(r, [[cx, cz], [cx + 1, cz]], 'red_carpet', 2)
    benches(r, [[cx, cz - 1], [cx + 1, cz - 1], [cx, cz + 1], [cx + 1, cz + 1]])
    along(r, OPPOSITE[r.s.doorSide], [[{ block: 'barrel' }], [{ block: 'chest', from: r.s.doorSide }], [{ block: 'crafting_table' }], [{ block: 'barrel' }]])
    r.lightCorners()
  },
  armoury(r) {
    const far = OPPOSITE[r.s.doorSide]
    along(r, far, [[{ block: 'anvil' }], [{ block: 'smithing_table' }], [{ block: 'grindstone' }], [{ block: 'blast_furnace', from: r.s.doorSide }], [{ block: 'barrel' }]])
    for (const side of r.shortSides)
      for (const [x, z] of r.wall(side, 1)) r.put(x, z, [{ block: 'iron_bars' }, { block: 'iron_bars' }])
    r.lightCorners()
  },
  library(r) {
    for (const side of ['north', 'south', 'east', 'west'] as Side[])
      for (const [x, z] of r.wall(side, 1)) r.put(x, z, [{ block: 'bookshelf' }, { block: 'bookshelf' }])
    const [cx, cz] = [Math.floor((r.s.x0 + r.s.x1) / 2), Math.floor((r.s.z0 + r.s.z1) / 2)]
    table(r, [[cx, cz], [cx + 1, cz]], 'green_carpet', 2)
    r.put(cx - 1, cz, [{ block: 'lectern', from: r.s.doorSide }])
    r.put(cx + 2, cz, [{ block: 'lectern', from: r.s.doorSide }])
    r.lightCorners()
  },
  chapel(r) {
    const far = OPPOSITE[r.s.doorSide]
    const altar = r.row(far, 1, 1)
    const mid = Math.floor(altar.length / 2)
    for (const i of [mid - 1, mid, mid + 1]) {
      const cell = altar[i]
      if (cell) r.put(cell[0], cell[1], [{ block: 'quartz_block' }, { block: i === mid ? 'gold_block' : 'candle' }])
    }
    for (const [x, z] of r.aisle(1)) r.put(x, z, [{ block: 'blue_carpet' }])
    const depth = far === 'north' || far === 'south' ? r.d : r.w
    for (let n = 3; n < depth - 1; n += 2) benches(r, r.row(far, n, 1))
    r.lightCorners()
  },
  solar(r) {
    const far = OPPOSITE[r.s.doorSide]
    along(r, far, [[{ block: 'bookshelf' }, { block: 'lantern' }], [{ block: 'noteblock' }], [{ block: 'jukebox' }], [{ block: 'bookshelf' }]])
    const [cx, cz] = [Math.floor((r.s.x0 + r.s.x1) / 2), Math.floor((r.s.z0 + r.s.z1) / 2)]
    table(r, [[cx, cz], [cx + 1, cz]], 'yellow_carpet', 3)
    r.put(cx, cz - 1, [{ block: 'spruce_slab' }])
    r.put(cx + 1, cz + 1, [{ block: 'spruce_slab' }])
    r.lightCorners()
    r.carpet('light_blue_carpet')
  },
  wizard_study(r) {
    const far = OPPOSITE[r.s.doorSide]
    for (const [x, z] of r.wall(far, 1)) r.put(x, z, [{ block: 'bookshelf' }, { block: 'bookshelf' }])
    const [cx, cz] = [Math.floor((r.s.x0 + r.s.x1) / 2), Math.floor((r.s.z0 + r.s.z1) / 2)]
    r.put(cx, cz, [{ block: 'enchanting_table' }])
    const [s1, s2] = r.shortSides
    along(r, s1, [[{ block: 'brewing_stand' }], [{ block: 'cauldron' }], [{ block: 'amethyst_block' }, { block: 'soul_lantern' }]])
    along(r, s2, [[{ block: 'lectern', from: OPPOSITE[s2] }], [{ block: 'chest', from: OPPOSITE[s2] }]])
    r.lightCorners('soul_lantern')
    r.carpet('purple_carpet')
  },
  workshop(r) {
    const far = OPPOSITE[r.s.doorSide]
    along(r, far, [[{ block: 'crafting_table' }], [{ block: 'stonecutter_block' }], [{ block: 'loom' }], [{ block: 'cartography_table' }], [{ block: 'fletching_table' }], [{ block: 'smithing_table' }]])
    for (const side of r.shortSides) along(r, side, [[{ block: 'barrel' }, { block: 'barrel' }], [{ block: 'barrel' }]])
    r.lightCorners()
  },
  stables(r) {
    const back = OPPOSITE[r.s.doorSide]
    r.wall(back, 0).forEach(([x, z], i) => {
      if (i % 3 === 0) r.put(x, z, [{ block: 'spruce_fence' }])
      else if (i % 3 === 1) r.put(x, z, [{ block: 'hay_block' }])
      else r.put(x, z, [{ block: 'cauldron' }])
    })
    r.lightCorners()
  },
}

function beds(r: Room, count: number, colour: number): number {
  const far = OPPOSITE[r.s.doorSide]
  const cells = r.row(far, 1, 1)
  let placed = 0
  for (let i = 0; i < cells.length && placed < count; i += 2) {
    const [x, z] = cells[i]
    if (r.bed(x, z, far, colour)) placed++
  }
  return placed
}

function chamber(r: Room, colour: number, carpet: string, extras: Placement[][]): void {
  beds(r, 1, colour)
  const far = OPPOSITE[r.s.doorSide]
  along(r, far, extras, 1)
  r.lightCorners()
  r.carpet(carpet)
}

/** Fill a room with the furniture of its type. */
export function furnish(space: RoomSpace): void {
  const room = new Room(space)
  if (room.w < 2 || room.d < 2) return
  FURNISH[space.type](room)
}
