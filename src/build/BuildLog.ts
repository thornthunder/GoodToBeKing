import fs from 'node:fs'
import path from 'node:path'
import type { Point } from './site'

export interface PlacedBlock extends Point {
  block: string
}

export interface BuildRecord {
  bot: string
  blueprint: string
  title: string
  requestedBy: string
  origin: Point
  finishedAt: number
  /** Every block this bot placed for the build, in placing order. */
  placed: PlacedBlock[]
}

/**
 * Which blocks each bot placed, so "take it down" removes exactly those and nothing else.
 * File-backed so it survives restarts.
 */
export class BuildLog {
  private builds: BuildRecord[] = []

  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { builds?: BuildRecord[] }
      this.builds = Array.isArray(parsed.builds) ? parsed.builds : []
    } catch {
      // Unreadable log: undo will simply have nothing to remove.
    }
  }

  add(record: BuildRecord): void {
    if (record.placed.length === 0) return
    this.builds.push(record)
    this.save()
  }

  /** The most recent build by this bot, if any. */
  last(bot: string): BuildRecord | undefined {
    return [...this.builds].reverse().find((b) => b.bot === bot)
  }

  remove(record: BuildRecord): void {
    this.builds = this.builds.filter((b) => b !== record)
    this.save()
  }

  all(): readonly BuildRecord[] {
    return this.builds
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify({ builds: this.builds }, null, 2))
  }
}
