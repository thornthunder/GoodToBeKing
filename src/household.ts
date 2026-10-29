import fs from 'node:fs'
import path from 'node:path'

/** A place the royal family chose, and who chose it when. */
export interface Spot {
  x: number
  y: number
  z: number
  setBy: string
  at: number
}

interface Saved {
  home?: Spot
  storehouse?: Spot
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

  setHome(p: { x: number; y: number; z: number }, setBy: string, now = Date.now()): Spot {
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
