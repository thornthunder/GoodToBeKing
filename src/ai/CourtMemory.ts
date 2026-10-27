import fs from 'node:fs'
import path from 'node:path'

export interface Fact {
  text: string
  /** When the fact was learned (ms since epoch). */
  at: number
}

/**
 * Real-world personal details that must never be stored, whatever the model extracts.
 * The princess is a child; this list errs on the side of dropping a fact.
 */
const PERSONAL_INFO =
  /\b(\d+\s*(years?|yrs?)\s*old|age[ds]?\b|birthday|born (on|in) (the )?(\d+\w*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)|school|teacher|class(mate)?|address|street|lives? (in|at|on)|phone|e-?mail|password|real name|surname|last name|full name)\b/i

export function isPersonalInfo(fact: string): boolean {
  return PERSONAL_INFO.test(fact)
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Long-term memory shared by every bot at court: short facts per subject (a player name or a
 * bot name). Backed by a JSON file so it survives restarts.
 */
export class CourtMemory {
  private data: Record<string, Fact[]> = {}
  /** Modification time of the file when last read or written; detects hand edits. */
  private loadedMtimeMs = 0

  constructor(
    private readonly file?: string,
    private readonly maxPerSubject = 40
  ) {
    this.refresh()
  }

  /** Re-read the file if someone edited it since we last read or wrote it. */
  private refresh(): void {
    if (!this.file || !fs.existsSync(this.file)) return
    const mtimeMs = fs.statSync(this.file).mtimeMs
    if (mtimeMs === this.loadedMtimeMs) return
    this.loadedMtimeMs = mtimeMs
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Fact[]>
      const data: Record<string, Fact[]> = {}
      for (const [subject, facts] of Object.entries(parsed)) {
        if (Array.isArray(facts)) data[subject] = facts.filter((f) => typeof f?.text === 'string')
      }
      this.data = data
    } catch {
      // A half-written or broken file: keep what we have rather than crashing or forgetting.
    }
  }

  /** Facts about a subject, oldest first. */
  facts(subject: string): string[] {
    this.refresh()
    return (this.data[subject.toLowerCase()] ?? []).map((f) => f.text)
  }

  /** Store new facts; duplicates and personal information are dropped. Returns what was kept. */
  add(subject: string, texts: string[], at = Date.now()): string[] {
    this.refresh()
    const key = subject.toLowerCase()
    const list = (this.data[key] ??= [])
    const seen = new Set(list.map((f) => normalise(f.text)))
    const added: string[] = []
    for (const raw of texts) {
      const text = raw.replace(/\s+/g, ' ').trim()
      const norm = normalise(text)
      if (!norm || seen.has(norm) || isPersonalInfo(text)) continue
      seen.add(norm)
      list.push({ text, at })
      added.push(text)
    }
    while (list.length > this.maxPerSubject) list.shift()
    if (added.length) this.save()
    return added
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs
  }
}
