import fs from 'node:fs'
import path from 'node:path'
import type { Farm } from './build/farm'
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
  /** Courtiers whose respawn point is a bed in the hall, and which bed. */
  spawns?: Record<string, { x: number; y: number; z: number }>
  /** What was in the storehouse when a courtier last opened it: item name -> count. */
  stock?: Record<string, number>
  stockAt?: number
}

/**
 * The court's household: its home (where courtiers with nothing to do gather) and its storehouse
 * (a chest the royal family pointed out), with what was last seen in it. File-backed.
 */
export class Household {
  private data: Saved = {}

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved
      } catch {
        // A broken file: the court simply has no home yet.
      }
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

  get farm(): Farm | undefined {
    return this.data.farm
  }

  setFarm(farm: Farm): void {
    this.data.farm = farm
    this.save()
  }

  /**
   * The court's own grounds: home, storehouse, field and mine. Nobody digs the land near them
   * (the hall's floor, the patches mended with dirt and the ground round the walls look like
   * untouched land, and digging them took the hall apart).
   */
  grounds(): Array<{ x: number; y: number; z: number }> {
    const out: Array<{ x: number; y: number; z: number }> = []
    if (this.home) out.push(this.home)
    if (this.storehouse) out.push(this.storehouse)
    const farm = this.farm
    for (const [x, z] of farm?.cells ?? []) out.push({ x, y: farm!.y, z })
    const hall = this.hall
    for (const [x, z] of hall?.ring ?? []) out.push({ x, y: hall!.floorY, z })
    if (this.mine) out.push(this.mine)
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
    this.data.home = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), setBy, at: now }
    this.save()
    return this.data.home
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

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
