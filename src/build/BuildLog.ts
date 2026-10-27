import fs from 'node:fs'
import path from 'node:path'
import type { Palette } from './blueprints'
import type { Point } from './site'

export interface PlacedBlock extends Point {
  block: string
}

export interface BuildRecord {
  /** Unique per build, so progress saves replace the same entry. */
  id: string
  bot: string
  blueprint: string
  title: string
  requestedBy: string
  origin: Point
  quarterTurns: number
  palette: Palette
  /** Foundation cells under the build. */
  fill: Point[]
  /** Blocks the build needs in total. */
  total: number
  /** False while building, or when the build stopped early: it can be resumed. */
  complete: boolean
  finishedAt: number
  /** Every block this bot placed for the build, in placing order. */
  placed: PlacedBlock[]
}

/**
 * Which blocks each bot placed, so "take it down" removes exactly those and nothing else, and an
 * interrupted build can be resumed at the same spot. File-backed; progress is saved as it goes.
 */
export class BuildLog {
  private builds: BuildRecord[] = []

  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { builds?: BuildRecord[] }
      this.builds = Array.isArray(parsed.builds) ? parsed.builds : []
    } catch {
      // Unreadable log: undo and resume will simply have nothing to work with.
    }
  }

  /** Add or replace (by id) a build record, and save. */
  upsert(record: BuildRecord): void {
    const i = this.builds.findIndex((b) => b.id === record.id)
    if (i >= 0) this.builds[i] = record
    else this.builds.push(record)
    this.save()
  }

  /** The most recent build by this bot, if any. */
  last(bot: string): BuildRecord | undefined {
    return [...this.builds].reverse().find((b) => b.bot === bot)
  }

  /** This bot's most recent build of a blueprint if it never finished. */
  unfinished(bot: string, blueprint: string): BuildRecord | undefined {
    const last = this.last(bot)
    return last && last.blueprint === blueprint && !last.complete ? last : undefined
  }

  remove(record: BuildRecord): void {
    this.builds = this.builds.filter((b) => b.id !== record.id)
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
