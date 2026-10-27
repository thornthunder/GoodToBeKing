import fs from 'node:fs'
import path from 'node:path'

/**
 * When each player was last hailed, keyed by lower-cased player name. With a file it survives
 * restarts, so a bot that restarts mid-session does not hail everyone all over again.
 */
export class HailLog {
  private readonly times = new Map<string, number>()

  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') this.times.set(key, value)
      }
    } catch {
      // A corrupt file only means some extra hails; start fresh.
    }
  }

  get(player: string): number | undefined {
    return this.times.get(player.toLowerCase())
  }

  set(player: string, at = Date.now()): void {
    this.times.set(player.toLowerCase(), at)
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.times), null, 2))
  }

  /** True when the player was hailed less than `windowMs` ago. */
  recent(player: string, windowMs: number, now = Date.now()): boolean {
    const last = this.get(player)
    return last !== undefined && now - last < windowMs
  }
}
