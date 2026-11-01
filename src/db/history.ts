import { isSecret } from '../ai/CourtMemory'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import type { Database, Queryable } from './Database'

/**
 * The court's history in the database: what was said where the court could hear it, the server's
 * notices (deaths, joins, achievements), Merlin's spells, the royals' orders and rules, and the
 * court's work (the household's and the army's). The admin reads it (Court > History). Recording never waits for the
 * database: lines wait in memory and go in every two seconds; while the database is away they
 * keep waiting (the newest 5000). Talk is kept as long as the logs keep it (HISTORY_CHAT_DAYS,
 * a week), the rest a month (HISTORY_DAYS).
 */
export type HistoryKind = 'chat' | 'notice' | 'magic' | 'order' | 'work' | 'court'

export const HISTORY_KINDS: HistoryKind[] = ['chat', 'notice', 'magic', 'order', 'work', 'court']

/** Kinds that hold what players said, kept no longer than the logs keep it. */
const TALK: HistoryKind[] = ['chat', 'notice']

export interface HistoryEvent {
  kind: HistoryKind
  /** Who spoke or acted. */
  actor?: string
  /** Whom it was for: the one whispered to, a spell's target, the courtier given an order. */
  target?: string
  text: string
  data?: Record<string, unknown>
}

export interface HistoryRow extends Required<Omit<HistoryEvent, 'data'>> {
  id: number
  at: number
  world: string
  division: string
  data: Record<string, unknown> | null
}

export interface HistoryOptions {
  world: string
  division: string
  /** Days to keep talk (chat and notices). */
  chatDays: number
  /** Days to keep the rest. */
  keepDays: number
}

/** A line that looked like a password or login is never written down (as in the memories). */
export const WITHHELD = '(withheld: it looked like a password or login)'

const FLUSH_MS = 2_000
const BATCH = 200
const MAX_WAITING = 5_000
/** The same line twice within this long is one line (every bot of a mind hears it). */
const SAME_MS = 5_000
const PRUNE_MS = 60 * 60_000
const DAY = 24 * 60 * 60_000

export class History {
  private waiting: Array<HistoryEvent & { at: number }> = []
  private readonly recent = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private flushing?: Promise<void>
  private lastPrune = 0
  private down = ''

  constructor(
    private readonly db: Database,
    private readonly ready: Promise<void>,
    private readonly opts: HistoryOptions,
    private readonly log: Logger
  ) {}

  add(event: HistoryEvent, now = Date.now()): void {
    // eslint-disable-next-line no-control-regex
    const clean = event.text.replace(/\u0000/g, '')
    const text = event.kind === 'chat' && isSecret(clean) ? WITHHELD : clean
    for (const [k, at] of this.recent) if (now - at > SAME_MS) this.recent.delete(k)
    const key = `${event.kind}|${event.actor ?? ''}|${event.target ?? ''}|${text}`
    if (this.recent.has(key)) return
    this.recent.set(key, now)
    this.waiting.push({ ...event, text, at: now })
    if (this.waiting.length > MAX_WAITING) this.waiting.splice(0, this.waiting.length - MAX_WAITING)
  }

  /** How many lines wait for the database. */
  get backlog(): number {
    return this.waiting.length
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS)
    this.timer.unref()
  }

  /** Write what waits (at most a few seconds more when stopping). */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 3_000))])
  }

  flush(now = Date.now()): Promise<void> {
    this.flushing ??= this.write(now).finally(() => (this.flushing = undefined))
    return this.flushing
  }

  private async write(now: number): Promise<void> {
    await this.ready
    try {
      while (this.waiting.length) {
        const batch = this.waiting.slice(0, BATCH)
        await insertHistory(this.db, batch, this.opts)
        this.waiting.splice(0, batch.length)
      }
      if (this.down) this.log.info(`history: writing again (${this.down} was the trouble)`)
      this.down = ''
      if (now - this.lastPrune >= PRUNE_MS) {
        this.lastPrune = now
        const gone = await pruneHistory(this.db, this.opts, now)
        if (gone) this.log.debug(`history: ${gone} old lines let go`)
      }
    } catch (err) {
      const why = errMsg(err)
      if (!this.down) this.log.warn(`history: cannot write (${why}); the lines wait`)
      this.down = why
    }
  }
}

export async function insertHistory(
  db: Queryable,
  rows: Array<HistoryEvent & { at: number }>,
  where: { world: string; division: string }
): Promise<void> {
  if (!rows.length) return
  const cols = 8
  const values = rows
    .map((_, i) => `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(', ')})`)
    .join(', ')
  const params = rows.flatMap((r) => [
    new Date(r.at),
    where.world,
    where.division,
    r.kind,
    r.actor ?? '',
    r.target ?? '',
    r.text,
    r.data ? JSON.stringify(r.data) : null,
  ])
  await db.query(
    `insert into court_history (at, world, division, kind, actor, target, text, data) values ${values}`,
    params
  )
}

/** Let go of this world's old lines; returns how many. */
export async function pruneHistory(
  db: Queryable,
  opts: HistoryOptions,
  now = Date.now()
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `with gone as (
       delete from court_history
       where world = $1 and ((kind = any($2) and at < $3) or at < $4)
       returning 1
     ) select count(*)::int as n from gone`,
    [
      opts.world,
      TALK,
      new Date(now - opts.chatDays * DAY),
      new Date(now - Math.max(opts.keepDays, opts.chatDays) * DAY),
    ]
  )
  return Number(rows[0]?.n ?? 0)
}

export interface HistoryFilter {
  world?: string
  kind?: string
  /** A name: who spoke or acted, or whom it was for. */
  who?: string
  /** Words in the line. */
  q?: string
  /** Only lines older than this id (the next page). */
  before?: number
  /** Only lines newer than this id (following live). */
  after?: number
  limit?: number
}

function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** The newest lines first. */
export async function readHistory(db: Queryable, f: HistoryFilter): Promise<HistoryRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value)
    where.push(sql(params.length))
  }
  if (f.world) add((n) => `world = $${n}`, f.world)
  if (f.kind) add((n) => `kind = $${n}`, f.kind)
  if (f.who) add((n) => `(actor ilike $${n} or target ilike $${n})`, like(f.who))
  if (f.q) add((n) => `text ilike $${n}`, like(f.q))
  if (f.before) add((n) => `id < $${n}`, f.before)
  if (f.after) add((n) => `id > $${n}`, f.after)
  params.push(Math.min(Math.max(f.limit ?? 200, 1), 1000))
  const { rows } = await db.query<Record<string, unknown>>(
    `select id, at, world, division, kind, actor, target, text, data from court_history
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by id desc limit $${params.length}`,
    params
  )
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at as string | Date).getTime(),
    world: String(r.world),
    division: String(r.division),
    kind: r.kind as HistoryKind,
    actor: String(r.actor),
    target: String(r.target),
    text: String(r.text),
    data: (r.data as Record<string, unknown> | null) ?? null,
  }))
}

// ---- The process's own history (set up once in index.ts) ------------------------------------

let current: History | undefined

/** Note something in the court's history (nothing happens without a database). */
export function record(event: HistoryEvent): void {
  current?.add(event)
}

export function startHistory(history: History): void {
  current = history
  history.start()
}

export async function stopHistory(): Promise<void> {
  await current?.stop()
  current = undefined
}
