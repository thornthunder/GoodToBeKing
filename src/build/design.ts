/**
 * The castle design language: a small JSON description of a castle (walls, towers, buildings,
 * storeys and rooms by type) that `compileDesign` turns into blocks and work orders. The first
 * great castle was written by hand; later ones are written by the court's overlord model, so
 * `validateDesign` explains every problem in words a model can act on.
 *
 * Coordinates: `area` is in world coordinates (its north-west corner and size). Everything else
 * (towers, buildings, rooms, features, keepOut, existing) is relative to the area's north-west
 * corner: x grows east, z grows south, 0-based. Rectangles include their walls; rooms of a
 * storey share wall lines where they meet.
 */
import { BLUEPRINT_IDS, type BlueprintId } from './blueprints'

export type Side = 'north' | 'south' | 'east' | 'west'
export const SIDES: Side[] = ['north', 'south', 'east', 'west']

export const ROOM_TYPES = [
  'great_hall',
  'throne_room',
  'kitchen',
  'pantry',
  'storeroom',
  'royal_bedchamber',
  'princess_bedchamber',
  'bedchamber',
  'apprentices_chamber',
  'barracks',
  'guardroom',
  'armoury',
  'library',
  'chapel',
  'solar',
  'wizard_study',
  'workshop',
  'stables',
  'dining_hall',
] as const
export type RoomType = (typeof ROOM_TYPES)[number]

export const FEATURE_TYPES = ['garden', 'lamp', 'well'] as const
export type FeatureType = (typeof FEATURE_TYPES)[number]

export interface Rect {
  x: number
  z: number
  width: number
  depth: number
}

/** An opening in a wall: `at` counts along the side from its west (north/south sides) or north (east/west sides) end. */
export interface Opening {
  side: Side
  at: number
  width?: number
  height?: number
}

export interface RoomDesign extends Rect {
  name: string
  type: RoomType
  /** The wall where the seat of honour goes (throne, altar, high table, bed); default: opposite the door. */
  honour?: Side
}

export interface StoreyDesign {
  rooms: RoomDesign[]
}

export interface BuildingDesign extends Rect {
  name: string
  /** Bottom first. */
  storeys: StoreyDesign[]
  /** Doors in the outer walls of the ground storey. */
  doors?: Opening[]
  /** Column of the ladder that joins the storeys (needed with more than one storey). */
  ladder?: { x: number; z: number }
  /** Who should build it (the overlord's assignment); others help once they run out of work. */
  crew?: string[]
}

export interface TowerDesign {
  name: string
  x: number
  z: number
  size: number
  height: number
  doors?: Opening[]
}

export interface FeatureDesign extends Partial<Rect> {
  type: FeatureType
  x: number
  z: number
}

/** A build already standing (from Merlin's spellbook) that becomes part of the castle. */
export interface ExistingDesign extends Rect {
  name: string
  blueprint: BlueprintId
  /** World height of its bottom layer. */
  y: number
  /** Open a second gate in its back wall, opposite the front gate. */
  openBack?: boolean
}

export interface Materials {
  wall: string
  trim: string
  partition: string
  floor: string
  roof: string
  paving: string
  foundation: string
  window: string
  light: string
}

export interface CastleDesign {
  name: string
  /** World height of the ground floor layer (the floor blocks themselves). */
  floorY: number
  area: Rect
  /** Height of the curtain wall above the floor layer. */
  wallHeight?: number
  /** Openings in the curtain wall. */
  gates?: Opening[]
  towers?: TowerDesign[]
  buildings: BuildingDesign[]
  features?: FeatureDesign[]
  /** Areas left completely untouched. */
  keepOut?: Rect[]
  existing?: ExistingDesign[]
  storeyHeight?: number
  materials?: Partial<Materials>
}

export const DEFAULT_MATERIALS: Materials = {
  wall: 'stone_bricks',
  trim: 'chiseled_stone_bricks',
  partition: 'spruce_planks',
  floor: 'spruce_planks',
  roof: 'stone_bricks',
  paving: 'polished_andesite',
  foundation: 'cobblestone',
  window: 'glass_pane',
  light: 'lantern',
}

export const DEFAULT_STOREY_HEIGHT = 5
export const MAX_AREA = 72
export const MAX_STOREYS = 4

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.z >= outer.z &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.z + inner.depth <= outer.z + outer.depth
  )
}

/** Overlap of two rectangles' areas (sharing an edge line counts as overlap of 1 cell wide). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.depth && b.z < a.z + a.depth
}

/** Interiors overlap (rects that only share a wall line do not count). */
function interiorsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x + 1 < b.x + b.width - 1 &&
    b.x + 1 < a.x + a.width - 1 &&
    a.z + 1 < b.z + b.depth - 1 &&
    b.z + 1 < a.z + a.depth - 1
  )
}

function sideLength(r: { width: number; depth: number }, side: Side): number {
  return side === 'north' || side === 'south' ? r.width : r.depth
}

const isInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n)

/**
 * Everything wrong with a design, in plain sentences. An empty list means it can be compiled.
 */
export function validateDesign(d: CastleDesign): string[] {
  const errors: string[] = []
  const err = (s: string) => errors.push(s)
  if (!d || typeof d !== 'object') return ['the design must be a JSON object']
  if (!d.name) err('the design needs a name')
  if (!isInt(d.floorY)) err('floorY must be a whole number')
  const area = d.area
  if (!area || ![area.x, area.z, area.width, area.depth].every(isInt)) {
    err('area needs whole-number x, z, width and depth')
    return errors
  }
  if (area.width < 12 || area.depth < 12) err('the area must be at least 12 by 12')
  if (area.width > MAX_AREA || area.depth > MAX_AREA)
    err(`the area may be at most ${MAX_AREA} by ${MAX_AREA}`)
  const local: Rect = { x: 0, z: 0, width: area.width, depth: area.depth }
  const storeyHeight = d.storeyHeight ?? DEFAULT_STOREY_HEIGHT
  if (storeyHeight < 4 || storeyHeight > 7) err('storeyHeight must be between 4 and 7')

  const checkOpenings = (owner: string, r: { width: number; depth: number }, list?: Opening[]) => {
    for (const o of list ?? []) {
      if (!SIDES.includes(o.side)) err(`${owner}: door side must be north, south, east or west`)
      const w = o.width ?? 1
      if (!isInt(o.at) || o.at < 1 || o.at + w > sideLength(r, o.side) - 1)
        err(
          `${owner}: a door on the ${o.side} side must be inside that wall, away from the corners`
        )
    }
  }

  const solids: Array<{ name: string; rect: Rect }> = []
  for (const t of d.towers ?? []) {
    const rect = { x: t.x, z: t.z, width: t.size, depth: t.size }
    if (![t.x, t.z, t.size, t.height].every(isInt))
      err(`tower ${t.name}: x, z, size and height must be whole numbers`)
    if (t.size < 3 || t.size > 9) err(`tower ${t.name}: size must be between 3 and 9`)
    if (t.height < 4 || t.height > 24) err(`tower ${t.name}: height must be between 4 and 24`)
    if (!inside(rect, local)) err(`tower ${t.name} must lie inside the area`)
    checkOpenings(`tower ${t.name}`, rect, t.doors)
    solids.push({ name: `tower ${t.name}`, rect })
  }
  for (const b of d.buildings ?? []) {
    const label = `building ${b.name}`
    if (![b.x, b.z, b.width, b.depth].every(isInt)) {
      err(`${label}: x, z, width and depth must be whole numbers`)
      continue
    }
    if (b.width < 5 || b.depth < 5) err(`${label}: must be at least 5 by 5`)
    if (!inside(b, local)) err(`${label} must lie inside the area`)
    if (!Array.isArray(b.storeys) || b.storeys.length === 0)
      err(`${label}: needs at least one storey`)
    else if (b.storeys.length > MAX_STOREYS) err(`${label}: at most ${MAX_STOREYS} storeys`)
    checkOpenings(label, b, b.doors)
    if (!b.doors?.length) err(`${label}: needs at least one door so people can get in`)
    if ((b.storeys?.length ?? 0) > 1) {
      const l = b.ladder
      if (!l || !isInt(l.x) || !isInt(l.z))
        err(`${label}: needs a ladder (x, z) to join its storeys`)
      else if (l.x <= b.x || l.x >= b.x + b.width - 1 || l.z <= b.z || l.z >= b.z + b.depth - 1)
        err(
          `${label}: the ladder must stand inside the building, not in its walls (x from ${b.x + 1} to ${b.x + b.width - 2}, z from ${b.z + 1} to ${b.z + b.depth - 2}, counted from the castle's corner)`
        )
      else if (
        l.x !== b.x + 1 &&
        l.x !== b.x + b.width - 2 &&
        l.z !== b.z + 1 &&
        l.z !== b.z + b.depth - 2
      )
        err(`${label}: the ladder must stand right against an outer wall`)
    }
    for (const [k, s] of (b.storeys ?? []).entries()) {
      const rooms = s?.rooms ?? []
      if (rooms.length === 0) err(`${label}, storey ${k + 1}: needs at least one room`)
      for (const r of rooms) {
        const rl = `${label}, storey ${k + 1}, room ${r.name}`
        if (r.honour !== undefined && !SIDES.includes(r.honour))
          err(`${rl}: honour must be north, south, east or west`)
        if (!ROOM_TYPES.includes(r.type))
          err(`${rl}: unknown type "${r.type}"; use one of ${ROOM_TYPES.join(', ')}`)
        if (![r.x, r.z, r.width, r.depth].every(isInt))
          err(`${rl}: x, z, width and depth must be whole numbers`)
        else if (!inside(r, b))
          err(
            `${rl}: must lie inside its building (rooms use the same x and z as buildings, counted from the castle's corner, not from the building's own corner)`
          )
        else if (r.width < 4 || r.depth < 4) err(`${rl}: must be at least 4 by 4 (walls included)`)
      }
      for (let i = 0; i < rooms.length; i++)
        for (let j = i + 1; j < rooms.length; j++)
          if (interiorsOverlap(rooms[i], rooms[j]))
            err(`${label}, storey ${k + 1}: rooms ${rooms[i].name} and ${rooms[j].name} overlap`)
    }
    solids.push({ name: label, rect: b })
  }
  for (const e of d.existing ?? []) {
    if (!BLUEPRINT_IDS.includes(e.blueprint)) err(`existing ${e.name}: unknown blueprint`)
    solids.push({ name: `existing ${e.name}`, rect: e })
  }
  for (const k of d.keepOut ?? []) solids.push({ name: 'a keep-out area', rect: k })
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++)
      if (interiorsOverlap(solids[i].rect, solids[j].rect))
        err(`${solids[i].name} and ${solids[j].name} overlap`)
  for (const f of d.features ?? []) {
    if (!FEATURE_TYPES.includes(f.type)) err(`feature: unknown type "${f.type}"`)
    const rect = { x: f.x, z: f.z, width: f.width ?? 1, depth: f.depth ?? 1 }
    if (!inside(rect, { x: 1, z: 1, width: area.width - 2, depth: area.depth - 2 }))
      err(`${f.type} at ${f.x},${f.z} must lie inside the curtain wall`)
    for (const s of solids)
      if (overlaps(rect, s.rect)) err(`${f.type} at ${f.x},${f.z} overlaps ${s.name}`)
  }
  checkOpenings('the curtain wall', area, d.gates)
  return errors
}
