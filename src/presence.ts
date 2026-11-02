import { loadPresence, moveCourt, noteKing, sendHome, type Whereabouts } from './db/court'
import { FileKeeper, inDatabase, type InDatabase, type Keeper } from './db/shared'

/** The court goes back to its home world this long after the King was last in the other one. */
export const AWAY_MS = 24 * 60 * 60_000
/** How often the King's being here is written down (he is online for hours). */
const NOTE_MS = 60_000

/**
 * Where the court is, shared by the court of each world (one process per mind in each, one row in
 * the database or one file between them). Merlin is in every world at once; the rest of the court
 * in one, the home world unless the King called them to his (the King's wish, 2026-10-31), and
 * back home a day after the King was last there.
 */
export class Presence {
  private readonly keeper: Keeper<Whereabouts>

  /**
   * @param here this process's world, e.g. "creative"
   * @param home the court's own world, e.g. "dev": where it lives when not called away
   */
  constructor(
    where: string | InDatabase,
    readonly here: string,
    readonly home: string
  ) {
    const empty = (): Whereabouts => ({ world: home, at: 0, kingSeen: {} })
    this.keeper = inDatabase(where)
      ? where.shared.replica('presence', async (q) => (await loadPresence(q)) ?? empty(), empty)
      : new FileKeeper(where, (raw) => parse(raw, home), empty, { atomic: true })
  }

  /** The world the court is in now. */
  get world(): string {
    return this.keeper.read().world
  }

  courtHere(): boolean {
    return this.world === this.here
  }

  /** Who called the court to the world it is in, and when. */
  get calledBy(): { by?: string; at: number } {
    const { by, at } = this.keeper.read()
    return { by, at }
  }

  /** The King calls the court to this world. */
  callHere(by: string, now = Date.now()): void {
    this.keeper.update(
      (d) => {
        d.world = this.here
        d.at = now
        d.by = by
        d.kingSeen[this.here] = now
      },
      (tx) => moveCourt(tx, this.here, now, by, { kingHere: true })
    )
  }

  /** The King is in this world now (written at most once a minute). */
  noteKing(now = Date.now()): void {
    this.keeper.update(
      (d) => {
        if (now - (d.kingSeen[this.here] ?? 0) < NOTE_MS) return false
        d.kingSeen[this.here] = now
      },
      (tx) => noteKing(tx, this.here, this.home, now)
    )
  }

  /**
   * The court is here, away from home, and the King has not been here for a day: it goes home.
   * Returns true when it was sent.
   */
  returnIfForgotten(now = Date.now()): boolean {
    let sent = false
    this.keeper.update(
      (d) => {
        if (d.world !== this.here || this.here === this.home) return false
        const last = Math.max(d.at, d.kingSeen[this.here] ?? 0)
        if (now - last < AWAY_MS) return false
        d.world = this.home
        d.at = now
        delete d.by
        sent = true
      },
      (tx) => sendHome(tx, this.here, this.home, now)
    )
    return sent
  }
}

/** presence.json as written; no file yet: the court is at home. */
export function parse(raw: unknown, home: string): Whereabouts {
  const r = (raw ?? {}) as Partial<Whereabouts>
  return {
    world: typeof r.world === 'string' ? r.world : home,
    at: Number(r.at) || 0,
    ...(typeof r.by === 'string' ? { by: r.by } : {}),
    kingSeen: r.kingSeen && typeof r.kingSeen === 'object' ? { ...r.kingSeen } : {},
  }
}

/** "the Dev world" */
export function worldWords(world: string): string {
  return `the ${world[0]?.toUpperCase() ?? ''}${world.slice(1)} world`
}
