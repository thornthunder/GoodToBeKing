import fs from 'node:fs'
import path from 'node:path'

/**
 * A side's playbook: the lessons it drew from its own rounds (src/war/lessons.ts, written by the
 * referee into the side's state), and how each round went. The captain reads it when planning.
 * This is the side's memory of the war: both sides run the same code and model, so the playbook
 * is all that experience changes.
 */
export interface Lesson {
  series: number
  round: number
  text: string
  at: number
}

export interface RoundRecord {
  series: number
  round: number
  /** "won", "lost" or "tie". */
  result: string
  /** One line: the score. */
  text: string
  at: number
}

export interface PlaybookData {
  lessons: Lesson[]
  rounds: RoundRecord[]
}

/** Lessons the captain is shown, newest first. */
export const LESSONS_SHOWN = 10
const ROUNDS_SHOWN = 6

export class Playbook {
  constructor(private readonly file: string) {}

  read(): PlaybookData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PlaybookData>
      return { lessons: raw.lessons ?? [], rounds: raw.rounds ?? [] }
    } catch {
      return { lessons: [], rounds: [] }
    }
  }

  private write(data: PlaybookData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  /** What the captain is told: lessons newest first, and the last rounds. */
  forPlanning(): { lessons: string[]; record: string[] } {
    const data = this.read()
    return {
      lessons: [...data.lessons]
        .reverse()
        .slice(0, LESSONS_SHOWN)
        .map((l) => `(series ${l.series}, round ${l.round}) ${l.text}`),
      record: data.rounds
        .slice(-ROUNDS_SHOWN)
        .map((r) => `series ${r.series}, round ${r.round}: ${r.result}; ${r.text}`),
    }
  }

  /** The referee adds a round's result and lessons. */
  learn(round: Omit<RoundRecord, 'at'>, lessons: string[], now = Date.now()): void {
    const data = this.read()
    data.rounds = data.rounds.filter((r) => !(r.series === round.series && r.round === round.round))
    data.rounds.push({ ...round, at: now })
    data.lessons = data.lessons.filter(
      (l) => !(l.series === round.series && l.round === round.round)
    )
    for (const text of lessons)
      data.lessons.push({ series: round.series, round: round.round, text, at: now })
    this.write(data)
  }
}
