import fs from 'node:fs'
import path from 'node:path'
import type { Farm } from './build/farm'
import type { FishingSpot } from './build/fishing'
import type { Grove } from './build/grove'
import type { Mine } from './bot/mining'

/** A place the royal family chose, and who chose it when. */
export interface Spot {
  x: number
  y: number
  z: number
  setBy: string
  at: number
}

/** The home hall as the court last saw it whole (see build/hall.ts). */
export interface SavedHall {
  floorY: number
  inside: Array<[number, number]>
  ring: Array<[number, number]>
  wallTop: number
  openings: Array<[number, number]>
  at: number
}

interface Saved {
  home?: Spot
  storehouse?: Spot
  hall?: SavedHall
  /** The court's wheat field (see build/farm.ts). */
  farm?: Farm
  /** The court's mine (see bot/mining.ts). */
  mine?: Mine
  /** Entrances of the court's mines worked out or given up. */
  oldMines?: Array<[number, number]>
  /** The court's grove (see build/grove.ts). */
  grove?: Grove
  /** Where the court fishes (see build/fishing.ts). */
  fishing?: FishingSpot
  /** When the court last looked for water to fish in near home and found none. */
  noWaterAt?: number
  /** Courtiers whose respawn point is a bed in the hall, and which bed. */
  spawns?: Record<string, { x: number; y: number; z: number }>
  /** What was in the storehouse when a courtier last opened it: item name -> count. */
  stock?: Record<string, number>
  stockAt?: number
  /** The storehouse the court left behind when it moved, and what was last seen in it. */
  formerStore?: Spot & { stock: Record<string, number> }
  /** The footprints of the buildings round home (see build/estate.ts): kept clear of the court's digging. */
  estate?: Array<{ x: number; z: number; width: number; depth: number }>
  /** What stands round home, in words (for the prompts). */
  estateWords?: string
}

/** Further than this from the new home, the old storehouse is left behind (and emptied). */
export const STORE_LEFT_BEHIND = 32
/** The open ground this far round the estate's buildings is not dug, tilled or planted. */
const ESTATE_CLEAR = 4

/**
 * The court's household: its home (where courtiers with nothing to do gather) and its storehouse
 * (a chest the royal family pointed out), with what was last seen in it. File-backed.
 */
/** A followed household is looked at again this often. */
const FOLLOW_MS = 2_000

export class Household {
  private saved: Saved = {}
  private mtime = 0
  private checked = 0

  /**
   * @param follow read only, as another mind keeps it (the army follows the household's): read
   *   again when the file changed, never written
   */
  constructor(
    private readonly file?: string,
    private readonly follow = false
  ) {
    this.load()
  }

  private get data(): Saved {
    if (this.follow && Date.now() - this.checked > FOLLOW_MS) this.load()
    return this.saved
  }

  private set data(value: Saved) {
    this.saved = value
  }

  private load(): void {
    this.checked = Date.now()
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const mtime = fs.statSync(this.file).mtimeMs
      if (mtime === this.mtime) return
      this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved
      this.mtime = mtime
    } catch {
      // A broken file (or one being written): the court simply has no home yet.
    }
  }

  get home(): Spot | undefined {
    return this.data.home
  }

  get storehouse(): Spot | undefined {
    return this.data.storehouse
  }

  /** The hall as last seen whole, for repairs. */
  get hall(): SavedHall | undefined {
    return this.data.hall
  }

  /** Is this column part of the hall (its walls or inside), as last seen whole? */
  hallColumn(x: number, z: number): boolean {
    const hall = this.hall
    if (!hall) return false
    return [...hall.ring, ...hall.inside].some(([hx, hz]) => hx === x && hz === z)
  }

  /** Is this spot inside the hall (as last seen whole)? */
  inHall(p: { x: number; y: number; z: number }): boolean {
    const hall = this.hall
    if (!hall || p.y < hall.floorY - 1 || p.y > hall.wallTop) return false
    const [x, z] = [Math.floor(p.x), Math.floor(p.z)]
    return hall.inside.some(([ix, iz]) => ix === x && iz === z)
  }

  setHall(hall: Omit<SavedHall, 'at'>, now = Date.now()): void {
    this.data.hall = { ...hall, at: now }
    this.save()
  }

  get mine(): Mine | undefined {
    return this.data.mine
  }

  setMine(mine: Mine): void {
    this.data.mine = { ...mine }
    this.save()
  }

  get oldMines(): Array<[number, number]> {
    return this.data.oldMines ?? []
  }

  /** A mine worked out (or flooded, or lost): its entrance is remembered, a new one is begun. */
  retireMine(mine: Mine): void {
    this.data.oldMines = [...this.oldMines, [mine.x, mine.z] as [number, number]].slice(-12)
    this.data.mine = undefined
    this.save()
  }

  get farm(): Farm | undefined {
    return this.data.farm
  }

  setFarm(farm: Farm): void {
    this.data.farm = farm
    this.save()
  }

  get fishing(): FishingSpot | undefined {
    return this.data.fishing
  }

  setFishing(spot: FishingSpot): void {
    this.data.fishing = spot
    this.data.noWaterAt = undefined
    this.save()
  }

  /** Water to fish in near home: true (a spot), false (none found lately), undefined (unknown). */
  waterNearHome(now = Date.now()): boolean | undefined {
    if (this.data.fishing) return true
    const at = this.data.noWaterAt
    // Looked again after an hour: the royal family may have dug a pond.
    return at !== undefined && now - at < 60 * 60_000 ? false : undefined
  }

  noteNoWater(now = Date.now()): void {
    this.data.noWaterAt = now
    this.save()
  }

  get grove(): Grove | undefined {
    return this.data.grove
  }

  setGrove(grove: Grove): void {
    this.data.grove = grove
    this.save()
  }

  /**
   * The court's own grounds: home, storehouse, field, grove and mine. Nobody digs the land near them
   * (the hall's floor, the patches mended with dirt and the ground round the walls look like
   * untouched land, and digging them took the hall apart).
   */
  grounds(): Array<{ x: number; y: number; z: number }> {
    const out: Array<{ x: number; y: number; z: number }> = []
    const home = this.home
    if (home) out.push(home)
    if (this.storehouse) out.push(this.storehouse)
    const farm = this.farm
    for (const [x, z] of farm?.cells ?? []) out.push({ x, y: farm!.y, z })
    const hall = this.hall
    for (const [x, z] of hall?.ring ?? []) out.push({ x, y: hall!.floorY, z })
    for (const [x, y, z] of this.grove?.spots ?? []) out.push({ x, y, z })
    if (this.mine) out.push(this.mine)
    // The estate's buildings: nobody digs beside a castle wall either.
    for (const [x, z] of this.estateColumns(8)) out.push({ x, y: home?.y ?? 64, z })
    return out
  }

  /** Where this courtier respawns, if it set its spawn at a bed in the hall. */
  spawnOf(name: string): { x: number; y: number; z: number } | undefined {
    return this.data.spawns?.[name]
  }

  setSpawn(name: string, bed: { x: number; y: number; z: number } | undefined): void {
    this.data.spawns ??= {}
    if (bed) this.data.spawns[name] = { x: bed.x, y: bed.y, z: bed.z }
    else delete this.data.spawns[name]
    this.save()
  }

  setHome(p: { x: number; y: number; z: number }, setBy: string, now = Date.now()): Spot {
    // A new home: the old hall's shape and the beds in it say nothing about it.
    this.data.hall = undefined
    this.data.spawns = undefined
    this.data.estate = undefined
    this.data.estateWords = undefined
    this.data.home = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), setBy, at: now }
    this.save()
    return this.data.home
  }

  /**
   * The court moves house: a new home, and everything it kept round the old one starts afresh
   * round the new (the field, the mine, the grove, the fishing spot). A storehouse left far
   * behind is remembered with its stock, to be carried over.
   */
  moveHome(p: { x: number; y: number; z: number }, setBy: string, now = Date.now()): Spot {
    const home = this.setHome(p, setBy, now)
    this.data.farm = undefined
    this.data.mine = undefined
    this.data.oldMines = undefined
    this.data.grove = undefined
    this.data.fishing = undefined
    this.data.noWaterAt = undefined
    const store = this.data.storehouse
    if (store && Math.hypot(store.x - home.x, store.z - home.z) > STORE_LEFT_BEHIND) {
      const left = Object.values(this.data.stock ?? {}).some((n) => n > 0)
      // An empty one is simply left; one with something in it is emptied into the new one.
      this.data.formerStore = left ? { ...store, stock: { ...this.data.stock } } : undefined
      this.data.storehouse = undefined
      this.data.stock = undefined
      this.data.stockAt = undefined
    }
    this.save()
    return home
  }

  /** The storehouse left behind, still to be emptied into the new one. */
  get formerStore(): (Spot & { stock: Record<string, number> }) | undefined {
    return this.data.formerStore
  }

  /** What was left in the old storehouse after a trip (nothing: it is done with). */
  noteFormerStock(items: Record<string, number> | undefined): void {
    const store = this.data.formerStore
    if (!store) return
    const left = Object.values(items ?? {}).some((n) => n > 0)
    this.data.formerStore = left && items ? { ...store, stock: items } : undefined
    this.save()
  }

  /** The buildings round home, as last surveyed. */
  get estate(): Array<{ x: number; z: number; width: number; depth: number }> {
    return this.data.estate ?? []
  }

  setEstate(
    areas: Array<{ x: number; z: number; width: number; depth: number }>,
    words?: string
  ): void {
    this.data.estate = areas.map(({ x, z, width, depth }) => ({ x, z, width, depth }))
    this.data.estateWords = words
    this.save()
  }

  /** What stands round home, in words, as last surveyed. */
  get estateWords(): string | undefined {
    return this.data.estateWords
  }

  /** Columns over the estate's buildings and the ground round them, every few blocks. */
  private estateColumns(step: number): Array<[number, number]> {
    const out: Array<[number, number]> = []
    for (const a of this.estate)
      for (let x = a.x - ESTATE_CLEAR; x <= a.x + a.width + ESTATE_CLEAR; x += step)
        for (let z = a.z - ESTATE_CLEAR; z <= a.z + a.depth + ESTATE_CLEAR; z += step)
          out.push([x, z])
    return out
  }

  /**
   * Where the court's own field, grove and mine must not go: the hall (or the home spot), the
   * field, and every building round home with the ground beside it (the King's castle).
   */
  keepClear(withField = true): Array<[number, number]> {
    const hall = this.hall
    const home = this.home
    return [
      ...(hall
        ? [...hall.ring, ...hall.inside]
        : home
          ? [[home.x, home.z] as [number, number]]
          : []),
      ...(withField ? (this.farm?.cells ?? []) : []),
      ...(this.grove?.spots.map(([x, , z]) => [x, z] as [number, number]) ?? []),
      ...this.estateColumns(4),
    ]
  }

  setStorehouse(p: { x: number; y: number; z: number }, setBy: string, now = Date.now()): Spot {
    this.data.storehouse = { x: p.x, y: p.y, z: p.z, setBy, at: now }
    // A new chest: what was in the old one says nothing about it.
    this.data.stock = undefined
    this.data.stockAt = undefined
    this.save()
    return this.data.storehouse
  }

  /** What a courtier saw in the storehouse just now. */
  noteStock(items: Record<string, number>, now = Date.now()): void {
    this.data.stock = items
    this.data.stockAt = now
    this.save()
  }

  get stock(): { items: Record<string, number>; at?: number } {
    return { items: this.data.stock ?? {}, at: this.data.stockAt }
  }

  /** "34 dirt, 12 oak logs" (most first), or "nothing" when it is empty. */
  stockWords(): string {
    const items = Object.entries(this.data.stock ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${n} ${name.replace(/_/g, ' ')}`)
    return items.length ? items.join(', ') : 'nothing'
  }

  /** Everything forgotten (a new round of the war game): no home, no stores, nothing seen. */
  forgetAll(): void {
    this.data = {}
    this.save()
  }

  private save(): void {
    if (!this.file || this.follow) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
