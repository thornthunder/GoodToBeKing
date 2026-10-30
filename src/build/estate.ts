/**
 * The court's estate: everything players built around the court's home, as the court sees it.
 * When a royal makes a place the court's home (a castle the King built, or one he found), the
 * court surveys what stands there instead of building its own: the buildings and their rooms,
 * the furniture in them, the corners no light reaches (monsters spawn there), the ways in that
 * have no door, and every block players placed, so damage can be measured against it later.
 * Pure functions over block names, like hall.ts.
 */
import type { BlockNames, Hall, HandCell } from './hall'

export interface EstateRoom {
  /** Feet level. */
  y: number
  /** Walkable columns of the room. */
  cells: Array<[number, number]>
  /** North-west corner and size of its floor (walls not included). */
  x: number
  z: number
  width: number
  depth: number
  /** Furniture by kind (beds counted as beds, not blocks). */
  furniture: Record<string, number>
  /** What it seems to be, from its furniture and size. */
  kind: RoomKind
}

export type RoomKind =
  'bedchamber' | 'kitchen' | 'smithy' | 'study' | 'storeroom' | 'workshop' | 'hall' | 'chamber'

export interface EstateBuilding {
  /** World north-west corner and size of its footprint. */
  x: number
  z: number
  width: number
  depth: number
  /** Lowest and highest block players placed in it. */
  base: number
  top: number
  /** Floors with rooms on them. */
  storeys: number
  /** The blocks it is mostly made of, most first ("stone bricks", "oak planks"). */
  materials: string[]
  rooms: EstateRoom[]
  /** Blocks players placed in it. */
  blocks: number
  /** The court's home is in it. */
  home: boolean
}

export interface Estate {
  home: { x: number; y: number; z: number }
  buildings: EstateBuilding[]
  /** Walkable spots under a roof (rooms, passages, doorways): x, y (feet), z. */
  interior: Array<[number, number, number]>
  /** Walkable spots in the open round the buildings (courtyards, the ground outside). */
  grounds: Array<[number, number, number]>
  /** Ways in one block wide, with a lintel and no door: x, y (feet), z. */
  doorless: Array<[number, number, number]>
  /** Doors already hung. */
  doors: number
  /** Furniture and where it stands: chest, furnace, crafting_table, bed (both halves)... */
  furniture: Record<string, Array<[number, number, number]>>
  /** Farmland squares. */
  farmland: number
  /** Every block players placed: "x,y,z" -> name. */
  made: Record<string, string>
}

export interface EstateOptions {
  /** How far the survey reaches from home, east-west and north-south. */
  radius?: number
  below?: number
  above?: number
}

export const ESTATE_RADIUS = 40
const BELOW = 10
const ABOVE = 30
/** A ceiling this close above a spot makes it indoors. */
const ROOF_REACH = 12
/** Footprints with fewer columns than this are lamp posts and the like, not buildings. */
const MIN_COLUMNS = 6
/** The open ground this far round each building is the court's to keep lit. */
const MARGIN = 4
/** Grounds this far above or below a building's base (its courtyard, the ground round it). */
const GROUND_SPAN = 3

/** Air and what a player walks through. */
const OPEN =
  /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow_layer|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|unlit_redstone_torch|[a-z_]*_carpet|carpet|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip|leaf_litter|wildflowers|deadbush|dead_bush|bush|firefly_bush|short_dry_grass|tall_dry_grass|vine|glow_lichen|allium|cornflower|azure_bluet|oxeye_daisy|lily_of_the_valley|blue_orchid|red_flower|yellow_flower|peony|rose_bush|lilac|sunflower|pink_petals|brown_mushroom|red_mushroom|fire|soul_fire|rail|[a-z_]*_rail|lever|[a-z_]*_button|[a-z_]*_pressure_plate|tripwire|redstone_wire|wheat|carrots|potatoes|beetroot|[a-z_]*_sapling|sweet_berry_bush|sugar_cane|reeds)$/
const LIQUID = /^(flowing_)?(water|lava)$|bubble_column/
const DOOR = /_door$/
/** What the world grew by itself: never counted as built. */
const WILD =
  /^(sand|red_sand|gravel|dirt|coarse_dirt|grass_block|grass|podzol|mycelium|rooted_dirt|mud|clay|stone|deepslate|sandstone|red_sandstone|andesite|diorite|granite|tuff|calcite|dripstone_block|pointed_dripstone|smooth_basalt|bedrock|obsidian|magma|terracotta|[a-z_]*_terracotta|snow|snow_layer|ice|packed_ice|blue_ice|powder_snow|moss_block|moss_carpet|[a-z_]*_leaves|[a-z_]*_log|[a-z_]*_ore|lit_redstone_ore|amethyst_block|budding_amethyst|amethyst_cluster|[a-z_]*_amethyst_bud|cactus|pumpkin|melon_block|melon|bee_nest|cobweb|web|kelp|kelp_plant|seagrass|tall_seagrass|sea_pickle|[a-z_]*coral[a-z_]*|bamboo|bamboo_sapling|cocoa|brown_mushroom_block|red_mushroom_block|mushroom_stem|azalea|flowering_azalea|big_dripleaf|small_dripleaf_block|spore_blossom|hanging_roots|cave_vines[a-z_]*|mangrove_roots|muddy_mangrove_roots|mangrove_propagule|waterlily|lily_pad|sculk[a-z_]*|infested_[a-z_]*)$/
/** Built, but flat or loose: no part of a building's shape (paths, fields, carpets, torches). */
const FLAT =
  /^(dirt_path|grass_path|farmland)$|carpet|rail|torch|lantern|flower_pot|button|lever|pressure_plate|tripwire|redstone_wire|_sign$|^sign$|banner|candle|frame|head$|skull/
/** Planted, grown and picked: the field's and the grove's business, not the estate's. */
const GROWING =
  /^(wheat|carrots|potatoes|beetroot|melon_stem|pumpkin_stem|[a-z_]*_sapling|sweet_berry_bush|sugar_cane|reeds|torchflower_crop|pitcher_crop)$/
/** Light lets through these (and air): glass, doors, fences, slabs, plants... */
const SEE_THROUGH =
  /glass|_pane$|iron_bars|_door$|trapdoor|fence|_wall$|_slab$|_stairs$|carpet|ladder|vine|sign|banner|bed$|chest$|flower_pot|leaves|water|lava|snow_layer|rail|lever|button|pressure_plate|cake|candle|end_rod|chain|lightning_rod|scaffolding|web|sugar_cane|reeds|wheat|carrots|potatoes|beetroot|_stem$|sapling|kelp|seagrass|bell|campfire|anvil|enchanting_table|brewing_stand|cauldron|hopper|lectern|grindstone|stonecutter|grass$|fern|flower|poppy|dandelion|tulip|orchid|allium|bluet|daisy|lily|peony|rose_bush|lilac|sunflower|petals|mushroom$|bush|leaf_litter|wildflowers|dripleaf|azalea$|spore_blossom|roots$|_bud$|cluster|pointed_dripstone|sea_pickle|frame|head$|skull|tripwire|redstone_wire|repeater|comparator|daylight_detector|conduit|beacon|honey_block|slime|ice$|propagule|glow_lichen|dirt_path|grass_path|farmland|torch|lantern|fire$/
/** Light sources and how bright they burn. */
const LIGHTS: Array<[RegExp, number]> = [
  [
    /^(lantern|glowstone|sea_lantern|sealantern|shroomlight|lit_pumpkin|jack_o_lantern|beacon|conduit|lit_redstone_lamp|campfire|lava|flowing_lava|fire|[a-z_]*_froglight)$/,
    15,
  ],
  [/^(torch|wall_torch|end_rod|cave_vines[a-z_]*with_berries)$/, 14],
  [/^lit_(furnace|smoker|blast_furnace)$/, 13],
  [/^(soul_torch|soul_wall_torch|soul_lantern|soul_campfire|soul_fire|crying_obsidian)$/, 10],
  [/^(redstone_torch|redstone_wall_torch|enchanting_table|ender_chest|glow_lichen)$/, 7],
  [/^magma$/, 3],
]
/** Furniture worth knowing about, by kind. */
const FURNITURE: Array<[RegExp, string]> = [
  [/bed$/, 'bed'],
  [/^(chest|trapped_chest|barrel)$/, 'chest'],
  [/^(lit_)?(furnace|smoker|blast_furnace)$/, 'furnace'],
  [/^campfire$/, 'furnace'],
  [/^crafting_table$/, 'crafting_table'],
  [/^(anvil|chipped_anvil|damaged_anvil|smithing_table|grindstone)$/, 'anvil'],
  [/^(bookshelf|chiseled_bookshelf|lectern)$/, 'bookshelf'],
  [/^(enchanting_table|brewing_stand)$/, 'enchanting_table'],
  [/^(loom|stonecutter|stonecutter_block|cartography_table|fletching_table)$/, 'workbench'],
  [/^cauldron$/, 'cauldron'],
]

const key = (x: number, y: number, z: number) => `${x},${y},${z}`
const open = (n: string | undefined) => n !== undefined && OPEN.test(n)
const solid = (n: string | undefined) => n !== undefined && !OPEN.test(n) && !LIQUID.test(n)

/** Placed by a player (or the court): not air, not water, not grown by the world. */
export function isMade(name: string | undefined): boolean {
  if (!name || open(name) || LIQUID.test(name) || GROWING.test(name)) return false
  return !WILD.test(name)
}

export function lightOf(name: string | undefined): number {
  if (!name) return 0
  return LIGHTS.find(([re]) => re.test(name))?.[1] ?? 0
}

function seeThrough(name: string | undefined): boolean {
  return name !== undefined && (open(name) || SEE_THROUGH.test(name))
}

/** Every block of a box around home read once (the survey reads each a dozen times). */
class Grid {
  private readonly cells: Array<string | undefined>
  readonly x0: number
  readonly z0: number
  readonly y0: number
  readonly size: number
  readonly height: number

  constructor(
    private readonly names: BlockNames,
    home: { x: number; y: number; z: number },
    radius: number,
    below: number,
    above: number
  ) {
    this.x0 = home.x - radius
    this.z0 = home.z - radius
    this.y0 = home.y - below
    this.size = 2 * radius + 1
    this.height = below + above + 1
    this.cells = new Array(this.size * this.size * this.height)
    for (let i = 0; i < this.size; i++)
      for (let j = 0; j < this.size; j++)
        for (let k = 0; k < this.height; k++)
          this.cells[(i * this.size + j) * this.height + k] = names(
            this.x0 + i,
            this.y0 + k,
            this.z0 + j
          )
  }

  inside(x: number, y: number, z: number): boolean {
    return (
      x >= this.x0 &&
      x < this.x0 + this.size &&
      z >= this.z0 &&
      z < this.z0 + this.size &&
      y >= this.y0 &&
      y < this.y0 + this.height
    )
  }

  at = (x: number, y: number, z: number): string | undefined =>
    this.inside(x, y, z)
      ? this.cells[((x - this.x0) * this.size + (z - this.z0)) * this.height + (y - this.y0)]
      : this.names(x, y, z)
}

/** Feet and head free, solid ground below. */
function walkable(at: BlockNames, x: number, y: number, z: number): boolean {
  return open(at(x, y, z)) && open(at(x, y + 1, z)) && solid(at(x, y - 1, z))
}

/** A ceiling above (a tree's leaves are no roof). */
function roofed(at: BlockNames, x: number, y: number, z: number): boolean {
  for (let h = y + 2; h <= y + ROOF_REACH; h++) {
    const n = at(x, h, z)
    if (solid(n) && !/leaves/.test(n ?? '')) return true
  }
  return false
}

/** No way through at feet or head height (a door is a way through). */
function blocked(at: BlockNames, x: number, y: number, z: number): boolean {
  const feet = at(x, y, z)
  const head = at(x, y + 1, z)
  return (solid(feet) && !DOOR.test(feet ?? '')) || (solid(head) && !DOOR.test(head ?? ''))
}

/** One block wide between walls: a doorway or a passage. */
function narrow(at: BlockNames, x: number, y: number, z: number): boolean {
  return (
    (blocked(at, x - 1, y, z) && blocked(at, x + 1, y, z)) ||
    (blocked(at, x, y, z - 1) && blocked(at, x, y, z + 1))
  )
}

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

function roomKind(furniture: Record<string, number>, width: number, depth: number): RoomKind {
  const has = (k: string) => (furniture[k] ?? 0) > 0
  if (has('bed')) return 'bedchamber'
  if (has('anvil')) return 'smithy'
  if (has('furnace') || has('cauldron')) return 'kitchen'
  if (has('enchanting_table') || (furniture.bookshelf ?? 0) >= 3) return 'study'
  if ((furniture.chest ?? 0) >= 2) return 'storeroom'
  if (has('crafting_table') || has('workbench')) return 'workshop'
  if (Math.min(width, depth) >= 7 && width * depth >= 60) return 'hall'
  return 'chamber'
}

/** "stone_bricks" -> "stone bricks", most-used first. */
function materials(blocks: string[]): string[] {
  const counts = new Map<string, number>()
  for (const b of blocks) {
    if (FLAT.test(b) || FURNITURE.some(([re]) => re.test(b)) || DOOR.test(b)) continue
    // Stairs and slabs are of their block: "oak_stairs" counts as oak.
    const base = b.replace(/_(stairs|slab|double_slab|wall)$/, '')
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n], i) => i === 0 || n >= total * 0.1)
    .slice(0, 3)
    .map(([name]) => name.replace(/_/g, ' '))
}

/**
 * Survey what players built round the home spot: the buildings, the rooms under their roofs, the
 * furniture, the ways in without a door, and every placed block.
 */
export function surveyEstate(
  names: BlockNames,
  home: { x: number; y: number; z: number },
  opts: EstateOptions = {}
): Estate {
  const h = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) }
  const radius = opts.radius ?? ESTATE_RADIUS
  const grid = new Grid(names, h, radius, opts.below ?? BELOW, opts.above ?? ABOVE)
  const at = grid.at
  const made: Record<string, string> = {}
  const furniture: Record<string, Array<[number, number, number]>> = {}
  let farmland = 0
  // Columns with a building's blocks in them, and which blocks.
  const columns = new Map<string, string[]>()
  const span = new Map<string, [number, number]>()
  for (let x = grid.x0; x < grid.x0 + grid.size; x++)
    for (let z = grid.z0; z < grid.z0 + grid.size; z++)
      for (let y = grid.y0; y < grid.y0 + grid.height; y++) {
        const n = at(x, y, z)
        if (!isMade(n)) continue
        made[key(x, y, z)] = n!
        if (n === 'farmland') farmland++
        const kind = FURNITURE.find(([re]) => re.test(n!))?.[1]
        if (kind) (furniture[kind] ??= []).push([x, y, z])
        if (FLAT.test(n!)) continue
        const c = `${x},${z}`
        const list = columns.get(c) ?? []
        list.push(n!)
        columns.set(c, list)
        const s = span.get(c)
        span.set(c, s ? [Math.min(s[0], y), Math.max(s[1], y)] : [y, y])
      }
  // Buildings: footprints of touching columns (corners too).
  const seen = new Set<string>()
  const footprints: string[][] = []
  for (const start of columns.keys()) {
    if (seen.has(start)) continue
    const part: string[] = []
    const queue = [start]
    seen.add(start)
    while (queue.length) {
      const c = queue.pop()!
      part.push(c)
      const [cx, cz] = c.split(',').map(Number)
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const n = `${cx + dx},${cz + dz}`
          if (!seen.has(n) && columns.has(n)) {
            seen.add(n)
            queue.push(n)
          }
        }
    }
    if (part.length >= MIN_COLUMNS) footprints.push(part)
  }
  const interior: Array<[number, number, number]> = []
  const grounds: Array<[number, number, number]> = []
  const groundSeen = new Set<string>()
  const doorless: Array<[number, number, number]> = []
  let doors = 0
  const buildings: EstateBuilding[] = []
  const claimed = new Set<string>()
  for (const part of footprints) {
    const xs = part.map((c) => Number(c.split(',')[0]))
    const zs = part.map((c) => Number(c.split(',')[1]))
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
    const spans = part.map((c) => span.get(c)!)
    const base = Math.min(...spans.map((s) => s[0]))
    const top = Math.max(...spans.map((s) => s[1]))
    // Indoors: walkable spots under a ceiling within the footprint.
    const inside = new Set<string>()
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = base; y <= top; y++)
          if (walkable(at, x, y, z) && roofed(at, x, y, z)) {
            inside.add(key(x, y, z))
            interior.push([x, y, z])
          }
    // Rooms: indoor spots joined on one level, split at doorways and passages one block wide.
    const rooms: EstateRoom[] = []
    const roomSeen = new Set<string>()
    for (const k of inside) {
      if (roomSeen.has(k)) continue
      const [sx, sy, sz] = k.split(',').map(Number)
      if (narrow(at, sx, sy, sz)) continue
      const cells: Array<[number, number]> = []
      const queue: Array<[number, number]> = [[sx, sz]]
      roomSeen.add(k)
      while (queue.length) {
        const [x, z] = queue.pop()!
        cells.push([x, z])
        for (const [dx, dz] of SIDES) {
          const n = key(x + dx, sy, z + dz)
          if (roomSeen.has(n) || !inside.has(n) || narrow(at, x + dx, sy, z + dz)) continue
          roomSeen.add(n)
          queue.push([x + dx, z + dz])
        }
      }
      if (cells.length < 4) continue
      const rx = cells.map(([x]) => x)
      const rz = cells.map(([, z]) => z)
      const room = {
        y: sy,
        cells,
        x: Math.min(...rx),
        z: Math.min(...rz),
        width: Math.max(...rx) - Math.min(...rx) + 1,
        depth: Math.max(...rz) - Math.min(...rz) + 1,
      }
      // Furniture standing in the room or against its walls, each piece counted for one room.
      const things: Record<string, number> = {}
      for (const [x, z] of cells)
        for (const [dx, dz] of [[0, 0], ...SIDES])
          for (const y of [sy, sy + 1]) {
            const p = key(x + dx, y, z + dz)
            if (claimed.has(p)) continue
            const kind = FURNITURE.find(([re]) => re.test(at(x + dx, y, z + dz) ?? ''))?.[1]
            if (!kind) continue
            claimed.add(p)
            things[kind] = (things[kind] ?? 0) + 1
          }
      // A bed is two blocks.
      if (things.bed) things.bed = Math.ceil(things.bed / 2)
      rooms.push({ ...room, furniture: things, kind: roomKind(things, room.width, room.depth) })
    }
    // Ways in: an indoor spot one wide, with a lintel, next to the open air; a door or not.
    for (const k of inside) {
      const [x, y, z] = k.split(',').map(Number)
      const toOpen = SIDES.some(
        ([dx, dz]) => walkable(at, x + dx, y, z + dz) && !roofed(at, x + dx, y, z + dz)
      )
      if (toOpen && narrow(at, x, y, z) && solid(at(x, y + 2, z))) doorless.push([x, y, z])
    }
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = base; y <= top; y++)
          if (DOOR.test(at(x, y, z) ?? '') && !DOOR.test(at(x, y - 1, z) ?? '')) doors++
    // The open ground round it and its courtyards, near its foot.
    for (let x = x0 - MARGIN; x <= x1 + MARGIN; x++)
      for (let z = z0 - MARGIN; z <= z1 + MARGIN; z++)
        for (let y = base - GROUND_SPAN; y <= base + GROUND_SPAN; y++) {
          const k = key(x, y, z)
          if (groundSeen.has(k) || !walkable(at, x, y, z) || roofed(at, x, y, z)) continue
          groundSeen.add(k)
          grounds.push([x, y, z])
        }
    const levels = [...new Set(rooms.map((r) => r.y))].sort((a, b) => a - b)
    const storeys = levels.filter((y, i) => i === 0 || y - levels[i - 1] > 2).length
    buildings.push({
      x: x0,
      z: z0,
      width: x1 - x0 + 1,
      depth: z1 - z0 + 1,
      base,
      top,
      storeys,
      materials: materials(part.flatMap((c) => columns.get(c)!)),
      rooms,
      blocks: part.reduce((n, c) => n + columns.get(c)!.length, 0),
      home: h.x >= x0 && h.x <= x1 && h.z >= z0 && h.z <= z1,
    })
  }
  buildings.sort((a, b) => Number(b.home) - Number(a.home) || b.blocks - a.blocks)
  return { home: h, buildings, interior, grounds, doorless, doors, furniture, farmland, made }
}

/**
 * How bright each spot is from the light sources around it: "x,y,z" -> level. Light spreads
 * one block at a time through air, glass and the like, one level dimmer each step.
 */
export function lightLevels(
  names: BlockNames,
  spots: Array<[number, number, number]>
): Map<string, number> {
  const levels = new Map<string, number>()
  if (!spots.length) return levels
  // Every source that could reach a spot: the box round them, as far again as light goes.
  const reach = 14
  const xs = spots.map(([x]) => x)
  const ys = spots.map(([, y]) => y)
  const zs = spots.map(([, , z]) => z)
  const [x0, x1] = [Math.min(...xs) - reach, Math.max(...xs) + reach]
  const [y0, y1] = [Math.min(...ys) - reach, Math.max(...ys) + reach]
  const [z0, z1] = [Math.min(...zs) - reach, Math.max(...zs) + reach]
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const level = lightOf(names(x, y, z))
        if (level > 0) spread(names, levels, x, y, z, level)
      }
  return levels
}

const STEPS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const

function spread(
  names: BlockNames,
  levels: Map<string, number>,
  x: number,
  y: number,
  z: number,
  level: number
): void {
  const queue: Array<[number, number, number, number]> = [[x, y, z, level]]
  for (let i = 0; i < queue.length; i++) {
    const [qx, qy, qz, l] = queue[i]
    const k = key(qx, qy, qz)
    if ((levels.get(k) ?? 0) >= l) continue
    levels.set(k, l)
    if (l <= 1) continue
    for (const [dx, dy, dz] of STEPS) {
      const n = names(qx + dx, qy + dy, qz + dz)
      if (!seeThrough(n)) continue
      const next = l - (/leaves|water/.test(n ?? '') ? 2 : 1)
      if (next > (levels.get(key(qx + dx, qy + dy, qz + dz)) ?? 0))
        queue.push([qx + dx, qy + dy, qz + dz, next])
    }
  }
}

/** Mobs spawn only on top of a full, solid block. */
function spawnable(names: BlockNames, x: number, y: number, z: number): boolean {
  const below = names(x, y - 1, z)
  return solid(below) && !seeThrough(below) && !/bedrock/.test(below ?? '')
}

/** Spots in and round the estate where no light reaches: monsters spawn there in the dark. */
export function darkSpots(estate: Estate, names: BlockNames): Array<[number, number, number]> {
  const spots = [...estate.interior, ...estate.grounds].filter(
    ([x, y, z]) => open(names(x, y, z)) && open(names(x, y + 1, z)) && spawnable(names, x, y, z)
  )
  const levels = lightLevels(names, spots)
  return spots.filter(([x, y, z]) => (levels.get(key(x, y, z)) ?? 0) === 0)
}

/**
 * Torches until no spot in or round the estate is dark, nearest home first: on a wall at head
 * height indoors (one within three steps), standing on the ground outside. At most `max`.
 */
export function estateLightCells(estate: Estate, names: BlockNames, max = 24): HandCell[] {
  const dark = darkSpots(estate, names)
  if (!dark.length) return []
  const { x: hx, z: hz } = estate.home
  dark.sort(([ax, , az], [bx, , bz]) => Math.hypot(ax - hx, az - hz) - Math.hypot(bx - hx, bz - hz))
  const indoors = new Set(estate.interior.map(([x, y, z]) => key(x, y, z)))
  const lit = new Map<string, number>()
  const cells: HandCell[] = []
  // What the planned torches light, as if they stood already.
  const planned: BlockNames = (x, y, z) =>
    cells.some((c) => c.x === x && c.y === y && c.z === z) ? 'torch' : names(x, y, z)
  for (const [x, y, z] of dark) {
    if (cells.length >= max) break
    if ((lit.get(key(x, y, z)) ?? 0) > 0) continue
    let cell: HandCell | undefined
    if (indoors.has(key(x, y, z))) {
      // A wall nearby on the same floor, at head height, not the door.
      let best: { cell: HandCell; d: number } | undefined
      for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++) {
          const d = Math.abs(dx) + Math.abs(dz)
          if (d > 3 || (best && best.d <= d)) continue
          const [cx, cz] = [x + dx, z + dz]
          if (!indoors.has(key(cx, y, cz)) || narrow(names, cx, y, cz)) continue
          if (!open(names(cx, y + 1, cz)) || /torch/.test(names(cx, y + 1, cz) ?? '')) continue
          const wall = SIDES.find(([wx, wz]) => {
            const n = names(cx + wx, y + 1, cz + wz)
            return solid(n) && !DOOR.test(n ?? '') && !seeThrough(n)
          })
          if (wall)
            best = {
              d,
              cell: { x: cx, y: y + 1, z: cz, block: 'torch', against: [wall[0], 0, wall[1]] },
            }
        }
      cell = best?.cell
    }
    // Standing on the floor or the ground, not in a doorway, on something a torch stands on.
    if (!cell && !narrow(names, x, y, z) && !seeThrough(names(x, y - 1, z)))
      cell = { x, y, z, block: 'torch', against: [0, -1, 0] }
    if (!cell) {
      lit.set(key(x, y, z), 1)
      continue
    }
    cells.push(cell)
    spread(planned, lit, cell.x, cell.y, cell.z, 14)
  }
  return cells
}

/** Doors for the ways in without one (the item places both halves). */
export function estateDoorCells(estate: Estate, names: BlockNames, max = 4): HandCell[] {
  return estate.doorless
    .filter(([x, y, z]) => open(names(x, y, z)) && open(names(x, y + 1, z)))
    .slice(0, max)
    .map(([x, y, z]) => ({ x, y, z, block: 'wooden_door' }))
}

/** Blocks a builder puts back as they were, or else closes with stone, planks or dirt. */
const AS_IT_WAS =
  /_planks$|^(cobblestone|mossy_cobblestone|stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|bricks|cobbled_deepslate|deepslate_bricks|polished_[a-z_]+|smooth_stone|sandstone|[a-z_]*_wool|[a-z_]*_concrete|[a-z_]*_log|stripped_[a-z_]+|[a-z_]*_wood|andesite|diorite|granite|tuff|dirt)$/
/** Lost blocks a hole is left by, closed with filler when the same is not to be had. */
const SHAPE = /_stairs$|_slab$|_wall$/
/** Not mended by the estate's repairs: furniture, doors and light have their own jobs; glass and decorations wait for the royals. */
const NOT_MENDED =
  /glass|_pane$|iron_bars|fence|door|sign|banner|bed$|chest|barrel|furnace|smoker|crafting_table|torch|lantern|carpet|flower_pot|rail|button|lever|pressure_plate|ladder|leaves|frame|head$|skull|candle|bell|anvil|enchanting|brewing|cauldron|bookshelf|lectern|loom|stonecutter|grindstone|composter|hay_block|farmland|dirt_path|grass_path/

/**
 * What the estate lost since it was last seen whole (`before`): the same blocks where the
 * storehouse has them (`has`), stone, planks or dirt otherwise. Bottom up, so each rests on
 * something. Not loaded: not known to be lost.
 */
export function estateRepairCells(
  before: Record<string, string>,
  names: BlockNames,
  has: (block: string) => boolean = () => false,
  max = 64
): HandCell[] {
  const cells: HandCell[] = []
  for (const [k, was] of Object.entries(before)) {
    if (NOT_MENDED.test(was) || FLAT.test(was)) continue
    const [x, y, z] = k.split(',').map(Number)
    const now = names(x, y, z)
    if (now === undefined || !(open(now) || LIQUID.test(now))) continue
    const same = AS_IT_WAS.test(was) && has(was)
    if (!same && !AS_IT_WAS.test(was) && !SHAPE.test(was)) continue
    cells.push({ x, y, z, block: same ? was : 'filler' })
  }
  cells.sort((a, b) => a.y - b.y)
  return cells.slice(0, max)
}

/**
 * The room the home spot is in, as a hall the court's hall work understands (beds, the chest,
 * the furnace, the crafting table go there): its floor, the wall ring round it, its ways in.
 */
export function homeRoom(estate: Estate, names: BlockNames): Hall | undefined {
  const { x, y, z } = estate.home
  const room = estate.buildings
    .flatMap((b) => b.rooms)
    .find((r) => Math.abs(r.y - y) <= 1 && r.cells.some(([cx, cz]) => cx === x && cz === z))
  if (!room) return undefined
  const inside = new Set(room.cells.map(([cx, cz]) => `${cx},${cz}`))
  const ring = new Set<string>()
  for (const [cx, cz] of room.cells)
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        if (!inside.has(`${cx + dx},${cz + dz}`)) ring.add(`${cx + dx},${cz + dz}`)
  const ringCells = [...ring].map((k) => k.split(',').map(Number) as [number, number])
  let wallTop = room.y + 1
  for (const [cx, cz] of room.cells) {
    let h = room.y + 2
    while (h < room.y + ROOF_REACH && !solid(names(cx, h, cz))) h++
    wallTop = Math.max(wallTop, h - 1)
  }
  const openings = ringCells.filter(
    ([cx, cz]) => !blocked(names, cx, room.y, cz) && open(names(cx, room.y + 1, cz))
  )
  return { floorY: room.y, inside: room.cells, ring: ringCells, wallTop, openings }
}

const DIRECTIONS = [
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
  'north',
  'north-east',
]

function whereFrom(home: { x: number; z: number }, b: EstateBuilding): string {
  const dx = b.x + b.width / 2 - home.x
  const dz = b.z + b.depth / 2 - home.z
  const d = Math.round(Math.hypot(dx, dz))
  const dir = DIRECTIONS[Math.round(Math.atan2(dz, dx) / (Math.PI / 4) + 8) % 8]
  return `${d} blocks ${dir} of it`
}

const KIND_WORDS: Record<RoomKind, string> = {
  bedchamber: 'a bedchamber',
  kitchen: 'a kitchen',
  smithy: 'a smithy',
  study: 'a study',
  storeroom: 'a storeroom',
  workshop: 'a workshop',
  hall: 'a hall',
  chamber: 'a chamber',
}

function roomWords(r: EstateRoom): string {
  const things = Object.entries(r.furniture)
    .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}${n > 1 && !/s$/.test(k) ? 's' : ''}`)
    .join(', ')
  return `${KIND_WORDS[r.kind]} ${r.width} by ${r.depth}${things ? ` (${things})` : ''}`
}

/** One building in words: its size, storeys, material and rooms. */
export function buildingWords(home: { x: number; z: number }, b: EstateBuilding): string {
  const where = b.home ? 'the one the home is in' : whereFrom(home, b)
  const height = b.top - b.base + 1
  const rooms = b.rooms.length
    ? `${b.rooms.length} room${b.rooms.length > 1 ? 's' : ''}: ${b.rooms.map(roomWords).join('; ')}`
    : 'no rooms (a wall or a fence)'
  return (
    `${b.width} by ${b.depth} blocks and ${height} high (${where}), ` +
    `${b.storeys > 1 ? `${b.storeys} storeys, ` : ''}of ${b.materials.join(' and ') || 'mixed blocks'}, ` +
    rooms
  )
}

/** The estate in a few sentences, for the Castellan's report and the overlord's brief. */
export function estateWords(estate: Estate, dark?: number): string {
  if (!estate.buildings.length) return 'Nothing anyone built stands near the home.'
  const lines = estate.buildings
    .slice(0, 6)
    .map((b, i) => `Building ${i + 1}: ${buildingWords(estate.home, b)}.`)
  if (estate.buildings.length > 6) lines.push(`And ${estate.buildings.length - 6} smaller works.`)
  const beds = estate.furniture.bed?.length ? Math.ceil(estate.furniture.bed.length / 2) : 0
  const count = (k: string) => estate.furniture[k]?.length ?? 0
  const has = [
    beds && `${beds} bed${beds > 1 ? 's' : ''}`,
    count('chest') && `${count('chest')} chests`,
    count('furnace') && `${count('furnace')} furnaces`,
    count('crafting_table') && `${count('crafting_table')} crafting tables`,
    estate.farmland && `${estate.farmland} squares of farmland`,
  ].filter(Boolean)
  if (has.length) lines.push(`In all: ${has.join(', ')}.`)
  const ways = estate.doorless.length
  lines.push(
    `${estate.doors} door${estate.doors === 1 ? '' : 's'} hung; ${ways} way${ways === 1 ? '' : 's'} in without a door.`
  )
  if (dark !== undefined)
    lines.push(
      dark
        ? `${dark} spots in and round it are dark enough for monsters to spawn.`
        : 'Every spot in and round it is lit.'
    )
  return lines.join(' ')
}
