import { loadHails, setHail } from '../db/court'
import { FileKeeper, inDatabase, type InDatabase, type Keeper } from '../db/shared'

/**
 * When each player was last hailed, keyed by lower-cased player name. Kept in the database or a
 * file, it survives restarts, so a bot that restarts mid-session does not hail everyone all over
 * again.
 */
export class HailLog {
  private readonly keeper: Keeper<Record<string, number>>
  private readonly bot: string

  constructor(where?: string | InDatabase) {
    if (inDatabase(where)) {
      const bot = (this.bot = (where.bot ?? '').toLowerCase())
      this.keeper = where.shared.replica(
        `hails:${bot}`,
        (q) => loadHails(q, bot),
        () => ({})
      )
    } else {
      this.bot = ''
      // A corrupt file only means some extra hails: start fresh.
      this.keeper = new FileKeeper(where, parseHails, () => ({}))
    }
  }

  get(player: string): number | undefined {
    return this.keeper.read()[player.toLowerCase()]
  }

  set(player: string, at = Date.now()): void {
    const key = player.toLowerCase()
    this.keeper.update(
      (times) => {
        times[key] = at
      },
      (tx) => setHail(tx, this.bot, key, at)
    )
  }

  /** True when the player was hailed less than `windowMs` ago. */
  recent(player: string, windowMs: number, now = Date.now()): boolean {
    const last = this.get(player)
    return last !== undefined && now - last < windowMs
  }
}

export function parseHails(raw: unknown): Record<string, number> {
  const times: Record<string, number> = {}
  for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>))
    if (typeof value === 'number') times[key] = value
  return times
}
