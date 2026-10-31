import fs from 'node:fs'
import path from 'node:path'

/** The court goes back to its home world this long after the King was last in the other one. */
export const AWAY_MS = 24 * 60 * 60_000
/** How often the King's being here is written down (he is online for hours). */
const NOTE_MS = 60_000

interface PresenceData {
  /** The world the court (all but the bots that are everywhere) is in. */
  world: string
  at: number
  by?: string
  /** When the King was last seen in each world. */
  kingSeen: Record<string, number>
}

/**
 * Where the court is, shared by the court of each world (one process each, one file between
 * them). Merlin is in every world at once; the rest of the court in one, the home world unless
 * the King called them to his (the King's wish, 2026-10-31), and back home a day after the King
 * was last there.
 */
export class Presence {
  private data: PresenceData
  private mtime = 0

  /**
   * @param here this process's world, e.g. "creative"
   * @param home the court's own world, e.g. "dev": where it lives when not called away
   */
  constructor(
    private readonly file: string,
    readonly here: string,
    readonly home: string
  ) {
    this.data = { world: home, at: 0, kingSeen: {} }
    this.read()
  }

  /** The world the court is in now. */
  get world(): string {
    this.read()
    return this.data.world
  }

  courtHere(): boolean {
    return this.world === this.here
  }

  /** Who called the court to the world it is in, and when. */
  get calledBy(): { by?: string; at: number } {
    this.read()
    return { by: this.data.by, at: this.data.at }
  }

  /** The King calls the court to this world. */
  callHere(by: string, now = Date.now()): void {
    this.read()
    this.data = { ...this.data, world: this.here, at: now, by }
    this.data.kingSeen[this.here] = now
    this.write()
  }

  /** The King is in this world now (written at most once a minute). */
  noteKing(now = Date.now()): void {
    this.read()
    if (now - (this.data.kingSeen[this.here] ?? 0) < NOTE_MS) return
    this.data.kingSeen[this.here] = now
    this.write()
  }

  /**
   * The court is here, away from home, and the King has not been here for a day: it goes home.
   * Returns true when it was sent.
   */
  returnIfForgotten(now = Date.now()): boolean {
    this.read()
    if (this.data.world !== this.here || this.here === this.home) return false
    const last = Math.max(this.data.at, this.data.kingSeen[this.here] ?? 0)
    if (now - last < AWAY_MS) return false
    this.data = { ...this.data, world: this.home, at: now, by: undefined }
    this.write()
    return true
  }

  /** The other court may have written it: read again when the file changed. */
  private read(): void {
    try {
      const mtime = fs.statSync(this.file).mtimeMs
      if (mtime === this.mtime) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PresenceData>
      this.mtime = mtime
      this.data = {
        world: typeof raw.world === 'string' ? raw.world : this.home,
        at: Number(raw.at) || 0,
        by: raw.by,
        kingSeen: raw.kingSeen ?? {},
      }
    } catch {
      // No file yet: the court is at home.
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
    this.mtime = fs.statSync(this.file).mtimeMs
  }
}

/** "the Dev world" */
export function worldWords(world: string): string {
  return `the ${world[0]?.toUpperCase() ?? ''}${world.slice(1)} world`
}
