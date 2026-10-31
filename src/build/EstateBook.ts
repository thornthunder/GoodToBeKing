import fs from 'node:fs'
import path from 'node:path'
import { roomOfHome, type Estate, type EstateBuilding } from './estate'

/** A block seen for the first time joins the estate once it has stood this long. */
export const SETTLE_MS = 10 * 60_000

/** A building as kept on file: its rooms without their floor plans. */
export type BuildingRecord = Omit<EstateBuilding, 'rooms'> & {
  rooms: Array<Omit<EstateBuilding['rooms'][number], 'cells'>>
}

export interface EstateRecord {
  home: { x: number; y: number; z: number }
  /** When the court first surveyed it, and last. */
  foundAt: number
  at: number
  /** Who made it the court's home. */
  setBy: string
  /** The survey in words (for the prompts and the overlord). */
  words: string
  buildings: BuildingRecord[]
  /** Every block players placed, as last seen whole: "x,y,z" -> name. */
  made: Record<string, string>
  /** New blocks not yet part of it: "x,y,z" -> [name, first seen]. */
  pending: Record<string, [string, number]>
  /** The home stood in a room under a roof when the court came (see `finished`). */
  finished?: boolean
}

/**
 * What the court knows of its estate, kept in `.state/estate.json`: the survey (for the prompts
 * and the overlord) and every block players placed as last seen whole, to mend damage against.
 * A new block joins once it has stood a while (scaffolding comes and goes). A block gone while
 * a royal was about is taken for the royals' doing and let go; one gone otherwise is damage.
 */
export class EstateBook {
  private data?: EstateRecord

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as EstateRecord
      } catch {
        // A broken file: the court surveys its estate again.
      }
    }
  }

  get record(): EstateRecord | undefined {
    return this.data
  }

  /** The estate of this home, if the court surveyed it. */
  of(home: { x: number; y: number; z: number }): EstateRecord | undefined {
    const d = this.data
    return d && d.home.x === home.x && d.home.y === home.y && d.home.z === home.z ? d : undefined
  }

  /** A new home: what stands there now is the estate as found. */
  found(estate: Estate, words: string, setBy: string, now = Date.now()): EstateRecord {
    this.data = {
      home: { ...estate.home },
      foundAt: now,
      at: now,
      setBy,
      words,
      buildings: strip(estate.buildings),
      made: { ...estate.made },
      pending: {},
      finished: roomOfHome(estate) !== undefined,
    }
    this.save()
    return this.data
  }

  /**
   * Was the home finished when the court came: in a room under a roof that players built (the
   * King's palace)? Then its walls, roof, doors and floor are the estate's, kept as they were,
   * not the hall's to close up: on 2026-10-31 the court roofed over a palace's stair to its roof
   * terrace and walled up two windows. A shell of walls a royal calls home is the court's to
   * finish (roof, floor, door), as before.
   */
  finished(home: { x: number; y: number; z: number }): boolean {
    const d = this.of(home)
    if (!d) return false
    if (d.finished !== undefined) return d.finished
    // Older records: a room round the home spot in the last survey.
    return d.buildings.some((b) =>
      b.rooms.some(
        (r) =>
          Math.abs(r.y - home.y) <= 1 &&
          home.x >= r.x &&
          home.x < r.x + r.width &&
          home.z >= r.z &&
          home.z < r.z + r.depth
      )
    )
  }

  /**
   * A later survey of the same estate: changed blocks are taken as they are, new ones join once
   * they have stood SETTLE_MS, and blocks gone where a royal was about lately are let go
   * (`royalChange`: a royal was near and no blast went off there). `seen`: whether a spot was
   * in sight (an unloaded spot says nothing).
   */
  update(
    estate: Estate,
    words: string,
    royalChange: (x: number, z: number, y: number) => boolean,
    seen: (x: number, y: number, z: number) => boolean,
    now = Date.now()
  ): void {
    const d = this.of(estate.home)
    if (!d) return
    for (const [k, name] of Object.entries(estate.made)) {
      if (d.made[k] !== undefined) {
        d.made[k] = name
        continue
      }
      const first = d.pending[k]
      if (!first || first[0] !== name) d.pending[k] = [name, now]
      else if (now - first[1] >= SETTLE_MS) {
        d.made[k] = name
        delete d.pending[k]
      }
    }
    // Gone again before it settled: scaffolding, or a royal trying something.
    for (const k of Object.keys(d.pending)) if (estate.made[k] === undefined) delete d.pending[k]
    for (const k of Object.keys(d.made)) {
      if (estate.made[k] !== undefined) continue
      const [x, y, z] = k.split(',').map(Number)
      if (seen(x, y, z) && royalChange(x, z, y)) delete d.made[k]
    }
    d.at = now
    d.words = words
    d.buildings = strip(estate.buildings)
    this.save()
  }

  clear(): void {
    this.data = undefined
    if (this.file && fs.existsSync(this.file)) fs.rmSync(this.file)
  }

  private save(): void {
    if (!this.file || !this.data) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data))
  }
}

function strip(buildings: EstateBuilding[]): BuildingRecord[] {
  return buildings.map((b) => ({
    ...b,
    rooms: b.rooms.map(({ cells: _cells, ...room }) => {
      void _cells
      return room
    }),
  }))
}
