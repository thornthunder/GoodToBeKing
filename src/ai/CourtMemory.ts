import { insertFacts, loadFacts, type Memory } from '../db/court'
import { FileKeeper, inDatabase, type InDatabase, type Keeper } from '../db/shared'

export interface Fact {
  text: string
  /** When the fact was learned (ms since epoch). */
  at: number
  /** About real life outside the game: shown only while nobody but the royal family is online. */
  private?: boolean
  /** Told to this bot in confidence: it never tells anyone. */
  secret?: boolean
}

/** Something to remember, and whether it is about real life or was told in confidence. */
export type NewFact = string | { text: string; private?: boolean; secret?: boolean }

/**
 * Real-world personal details. The family runs the server on its own hardware and wants the court
 * to remember them, so they are kept, but private (see Fact.private): a guest must never read the
 * princess's age or school in chat. The list errs on the side of marking a fact private.
 */
const PERSONAL_INFO =
  /\b(\d+\s*(years?|yrs?)\s*old|age[ds]?\b|birthday|born (on|in) (the )?(\d+\w*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)|school|teacher|class(mate)?|address|street|lives? (in|at|on)|phone|e-?mail|real name|surname|last name|full name)\b/i

/** Secrets are never stored, whoever tells them: passwords, PINs, login details, card numbers. */
const SECRET =
  /\b(pass(word|code)s?|pin (code|number)s?|log-?ins?|login details|(credit|bank|debit) cards?|card numbers?)\b/i

export function isPersonalInfo(fact: string): boolean {
  return PERSONAL_INFO.test(fact)
}

export function isSecret(fact: string): boolean {
  return SECRET.test(fact)
}

/** A fact as compared with the others: the same fact twice is kept once. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A memory file as written (subject -> facts), anything broken in it left out. */
export function parseMemory(raw: unknown): Memory {
  const data: Memory = {}
  for (const [subject, facts] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(facts))
      data[subject] = facts.filter((f): f is Fact => typeof f?.text === 'string')
  }
  return data
}

/**
 * One bot's long-term memory: short facts per subject (a player name or a bot name), only what
 * that bot heard itself. Kept in the database (DATABASE_URL) or a JSON file, so it survives
 * restarts; either is read again when changed elsewhere (Merlin is in both worlds; the admin
 * makes a courtier forget), and a file may be edited by hand while the court runs.
 */
export class CourtMemory {
  private readonly keeper: Keeper<Memory>
  /** Whose memory it is (in the database). */
  private readonly bot: string

  constructor(
    where?: string | InDatabase,
    private readonly maxPerSubject = 400
  ) {
    if (inDatabase(where)) {
      const bot = (this.bot = (where.bot ?? '').toLowerCase())
      this.keeper = where.shared.replica(
        `memory:${bot}`,
        (q) => loadFacts(q, bot),
        () => ({})
      )
    } else {
      this.bot = ''
      this.keeper = new FileKeeper(where, parseMemory, () => ({}))
    }
  }

  /** Facts about a subject, oldest first; real-life ones only when asked for. */
  facts(subject: string, opts: { withPrivate?: boolean } = {}): string[] {
    return this.entries(subject)
      .filter((f) => opts.withPrivate || !f.private)
      .map((f) => f.text)
  }

  /** Everything known about a subject, oldest first. */
  entries(subject: string): Fact[] {
    return (this.keeper.read()[subject.toLowerCase()] ?? []).map((f) => ({ ...f }))
  }

  /**
   * Store new facts; duplicates and secrets are dropped, real-life details are marked private.
   * Returns what was kept.
   */
  add(subject: string, facts: NewFact[], at = Date.now()): Fact[] {
    const key = subject.toLowerCase()
    const added: Fact[] = []
    this.keeper.update(
      (data) => {
        const list = (data[key] ??= [])
        const seen = new Set(list.map((f) => normalise(f.text)))
        for (const item of facts) {
          const raw = typeof item === 'string' ? item : item.text
          // The prompt marks private and secret facts itself; a mark copied into the text is undone.
          const text = raw
            .replace(/\s+/g, ' ')
            .replace(/(\s*\((private|secret)\)\.?)+\s*$/i, '')
            .trim()
          const norm = normalise(text)
          if (!norm || seen.has(norm) || isSecret(text)) continue
          seen.add(norm)
          const realLife = (typeof item !== 'string' && item.private) || isPersonalInfo(text)
          const secret = typeof item !== 'string' && item.secret
          const fact: Fact = {
            text,
            at,
            ...(realLife ? { private: true } : {}),
            ...(secret ? { secret: true } : {}),
          }
          list.push(fact)
          added.push(fact)
        }
        while (list.length > this.maxPerSubject) list.shift()
        return added.length > 0
      },
      (tx) =>
        insertFacts(
          tx,
          this.bot,
          key,
          added.map((f) => ({ ...f, norm: normalise(f.text) })),
          this.maxPerSubject
        )
    )
    return added
  }
}

/** Words too common in facts and chat to tell which old facts the talk is about. */
const COMMON = new Set(
  (
    'that this with have from they them their there what when where which will would about like ' +
    'likes love loves wants want called named name your yours just very more some also into ' +
    'been were said says told asked made make build built does should could highness majesty ' +
    'king queen prince princess royal lord lady merlin court castle'
  ).split(' ')
)

function keywords(text: string, ignore: Set<string>): string[] {
  return (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(
    (w) => !COMMON.has(w) && !ignore.has(w)
  )
}

/**
 * The facts to show for one subject: the most recent ones, plus older ones that share words with
 * the talk (the princess mentions her horse, the horse's name comes back). In the order learned.
 */
export function recall(
  facts: Fact[],
  talk: string,
  recent: number,
  relevant: number,
  ignore: Iterable<string> = []
): Fact[] {
  const skip = new Set([...ignore].map((w) => w.toLowerCase()))
  const cut = Math.max(0, facts.length - recent)
  const words = new Set(keywords(talk, skip))
  const older = facts
    .slice(0, cut)
    .map((fact, i) => ({
      fact,
      i,
      score: keywords(fact.text, skip).filter((w) => words.has(w)).length,
    }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, relevant)
    .sort((a, b) => a.i - b.i)
  return [...older.map((o) => o.fact), ...facts.slice(cut)]
}
