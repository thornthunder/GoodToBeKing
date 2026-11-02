import type { Fact } from '../ai/CourtMemory'
import type { Order, Post, Rule } from '../ai/orders'
import type { Queryable } from './Database'

/**
 * The court's shared state in the database (step 2 of the move from files): each courtier's
 * memories, standing orders, reports and hails, the royals' rules, and the world the court is in.
 * The stores (CourtMemory, OrderBook, CourtRules, HailLog, Presence) keep their data in memory
 * and write through these; the admin reads and changes the same rows. Every change goes with a
 * bump of its scope's version (shared.ts), so the processes holding it load it again.
 */

const ms = (at: unknown): number => (at ? new Date(at as string | Date).getTime() : 0)

/** Facts and orders are deduplicated on their normalised text, cut to fit an index. */
const NORM_MAX = 500

// ---- Memories ---------------------------------------------------------------------------------

export type Memory = Record<string, Fact[]>

export async function loadFacts(q: Queryable, bot: string): Promise<Memory> {
  const { rows } = await q.query<Record<string, unknown>>(
    'select subject, text, at, private, secret from court_facts where bot = $1 order by subject, id',
    [bot]
  )
  const memory: Memory = {}
  for (const r of rows)
    (memory[String(r.subject)] ??= []).push({
      text: String(r.text),
      at: ms(r.at),
      ...(r.private ? { private: true } : {}),
      ...(r.secret ? { secret: true } : {}),
    })
  return memory
}

/** New facts about a subject (the same fact twice is kept once); the oldest beyond `max` go. */
export async function insertFacts(
  q: Queryable,
  bot: string,
  subject: string,
  facts: Array<Fact & { norm: string }>,
  max: number
): Promise<void> {
  if (facts.length) {
    const values = facts.map(
      (_, i) =>
        `($1, $2, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6}, $${i * 5 + 7})`
    )
    await q.query(
      `insert into court_facts (bot, subject, text, norm, at, private, secret)
       values ${values.join(', ')} on conflict (bot, subject, norm) do nothing`,
      [
        bot,
        subject,
        ...facts.flatMap((f) => [
          f.text,
          f.norm.slice(0, NORM_MAX),
          new Date(f.at),
          Boolean(f.private),
          Boolean(f.secret),
        ]),
      ]
    )
  }
  await q.query(
    `delete from court_facts where id in (
       select id from court_facts where bot = $1 and subject = $2 order by id desc offset $3
     )`,
    [bot, subject, max]
  )
}

/** A fact forgotten (the admin); returns whether there was one. */
export async function deleteFact(
  q: Queryable,
  bot: string,
  subject: string,
  fact: { text: string; at: number }
): Promise<boolean> {
  const { rows } = await q.query(
    'delete from court_facts where bot = $1 and subject = $2 and text = $3 and at = $4 returning id',
    [bot, subject, fact.text, new Date(fact.at)]
  )
  return rows.length > 0
}

/** How much each courtier remembers. */
export async function memorySizes(
  q: Queryable
): Promise<Map<string, { subjects: number; facts: number }>> {
  const { rows } = await q.query<{ bot: string; subjects: number; facts: number }>(
    `select bot, count(distinct subject)::int as subjects, count(*)::int as facts
     from court_facts group by bot`
  )
  return new Map(rows.map((r) => [r.bot, { subjects: r.subjects, facts: r.facts }]))
}

// ---- Counters (order and rule numbers) --------------------------------------------------------

/**
 * The number for a new order or rule: the one proposed, unless another process gave it (or a
 * higher one) meanwhile; then the next free one.
 */
async function take(q: Queryable, name: string, proposed: number): Promise<number> {
  const { rows } = await q.query<{ num: number }>(
    `insert into court_counters (name, next) values ($1, $2::int + 1)
     on conflict (name) do update set next = greatest(court_counters.next, $2::int) + 1
     returning next - 1 as num`,
    [name, proposed]
  )
  return Number(rows[0].num)
}

async function counter(q: Queryable, name: string): Promise<number | undefined> {
  const { rows } = await q.query<{ next: number }>(
    'select next from court_counters where name = $1',
    [name]
  )
  return rows.length ? Number(rows[0].next) : undefined
}

/** Raise a counter to at least `next` (taking in the files). */
export async function raiseCounter(q: Queryable, name: string, next: number): Promise<void> {
  await q.query(
    `insert into court_counters (name, next) values ($1, $2::int)
     on conflict (name) do update set next = greatest(court_counters.next, $2::int)`,
    [name, next]
  )
}

const num = (id: string): number => Number(id.replace(/^[A-Z]/, '')) || 0

// ---- Standing orders and reports ----------------------------------------------------------------

export interface Book {
  next: number
  orders: Order[]
  reports: string[]
}

export async function loadBook(q: Queryable, bot: string): Promise<Book> {
  const orders = await q.query<Record<string, unknown>>(
    'select num, giver, giver_title, text, post, at from court_orders where bot = $1 order by num',
    [bot]
  )
  const reports = await q.query<{ text: string }>(
    'select text from court_reports where bot = $1 order by id',
    [bot]
  )
  const list: Order[] = orders.rows.map((r) => ({
    id: `O${Number(r.num)}`,
    from: String(r.giver),
    by: String(r.giver_title),
    text: String(r.text),
    ...(r.post ? { post: r.post as Post } : {}),
    at: ms(r.at),
  }))
  const highest = Math.max(0, ...list.map((o) => num(o.id)))
  return {
    next: Math.max((await counter(q, `orders:${bot}`)) ?? 1, highest + 1),
    orders: list,
    reports: reports.rows.map((r) => r.text),
  }
}

/** A new standing order (numbered afresh if its number was taken); the oldest beyond `max` go. */
export async function insertOrder(
  q: Queryable,
  bot: string,
  order: Order,
  max: number
): Promise<void> {
  const n = await take(q, `orders:${bot}`, num(order.id))
  await q.query(
    `insert into court_orders (bot, num, giver, giver_title, text, post, at)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (bot, num) do nothing`,
    [
      bot,
      n,
      order.from,
      order.by,
      order.text,
      order.post ? JSON.stringify(order.post) : null,
      new Date(order.at),
    ]
  )
  await q.query(
    `delete from court_orders where bot = $1 and num in (
       select num from court_orders where bot = $1 order by num desc offset $2
     )`,
    [bot, max]
  )
}

/** Orders released; returns how many there were. */
export async function deleteOrders(q: Queryable, bot: string, ids: string[]): Promise<number> {
  const { rows } = await q.query(
    'delete from court_orders where bot = $1 and num = any($2) returning num',
    [bot, ids.map(num)]
  )
  return rows.length
}

export async function insertReport(
  q: Queryable,
  bot: string,
  text: string,
  at = Date.now()
): Promise<void> {
  await q.query('insert into court_reports (bot, text, at) values ($1, $2, $3)', [
    bot,
    text,
    new Date(at),
  ])
}

/** The reports given (only those: one written meanwhile elsewhere is still owed). */
export async function deleteReports(q: Queryable, bot: string, texts: string[]): Promise<void> {
  await q.query('delete from court_reports where bot = $1 and text = any($2)', [bot, texts])
}

// ---- The royals' rules ----------------------------------------------------------------------------

export async function loadRules(q: Queryable): Promise<{ next: number; rules: Rule[] }> {
  const { rows } = await q.query<Record<string, unknown>>(
    'select num, giver, giver_title, text, at from court_rules order by num'
  )
  const rules: Rule[] = rows.map((r) => ({
    id: `R${Number(r.num)}`,
    from: String(r.giver),
    by: String(r.giver_title),
    text: String(r.text),
    at: ms(r.at),
  }))
  const highest = Math.max(0, ...rules.map((r) => num(r.id)))
  return { next: Math.max((await counter(q, 'rules')) ?? 1, highest + 1), rules }
}

export async function insertRule(q: Queryable, rule: Rule): Promise<void> {
  const n = await take(q, 'rules', num(rule.id))
  await q.query(
    `insert into court_rules (num, giver, giver_title, text, at) values ($1, $2, $3, $4, $5)
     on conflict (num) do nothing`,
    [n, rule.from, rule.by, rule.text, new Date(rule.at)]
  )
}

export async function deleteRules(q: Queryable, ids: string[]): Promise<number> {
  const { rows } = await q.query('delete from court_rules where num = any($1) returning num', [
    ids.map(num),
  ])
  return rows.length
}

// ---- Hails --------------------------------------------------------------------------------------

export async function loadHails(q: Queryable, bot: string): Promise<Record<string, number>> {
  const { rows } = await q.query<{ player: string; at: unknown }>(
    'select player, at from court_hails where bot = $1',
    [bot]
  )
  return Object.fromEntries(rows.map((r) => [r.player, ms(r.at)]))
}

export async function setHail(
  q: Queryable,
  bot: string,
  player: string,
  at: number
): Promise<void> {
  await q.query(
    `insert into court_hails (bot, player, at) values ($1, $2, $3)
     on conflict (bot, player) do update set at = greatest(court_hails.at, excluded.at)`,
    [bot, player, new Date(at)]
  )
}

// ---- Where the court is -------------------------------------------------------------------------

export interface Whereabouts {
  /** The world the court (all but the bots that are everywhere) is in. */
  world: string
  at: number
  by?: string
  /** When the King was last seen in each world. */
  kingSeen: Record<string, number>
}

export async function loadPresence(q: Queryable): Promise<Whereabouts | undefined> {
  const { rows } = await q.query<Record<string, unknown>>(
    'select world, at, called_by, king_seen from court_presence where id = 1'
  )
  const r = rows[0]
  if (!r) return undefined
  const seen = (r.king_seen ?? {}) as Record<string, unknown>
  return {
    world: String(r.world),
    at: ms(r.at),
    ...(r.called_by ? { by: String(r.called_by) } : {}),
    kingSeen: Object.fromEntries(Object.entries(seen).map(([w, at]) => [w, Number(at) || 0])),
  }
}

/** The court goes to `world` (called by the King, or moved by the admin). */
export async function moveCourt(
  q: Queryable,
  world: string,
  at: number,
  by: string | undefined,
  opts: { kingHere?: boolean } = {}
): Promise<void> {
  await q.query(
    `insert into court_presence (id, world, at, called_by, king_seen)
     values (1, $1, $2, $3, case when $4::boolean then jsonb_build_object($1::text, $5::bigint)
       else '{}'::jsonb end)
     on conflict (id) do update set world = excluded.world, at = excluded.at,
       called_by = excluded.called_by, king_seen = court_presence.king_seen || excluded.king_seen`,
    [world, new Date(at), by ?? null, Boolean(opts.kingHere), at]
  )
}

/** The King is in `world` now. */
export async function noteKing(
  q: Queryable,
  world: string,
  home: string,
  at: number
): Promise<void> {
  await q.query(
    `insert into court_presence (id, world, king_seen) values (1, $1, jsonb_build_object($2::text, $3::bigint))
     on conflict (id) do update set king_seen = court_presence.king_seen || excluded.king_seen`,
    [home, world, at]
  )
}

/** The court goes home from `here`, if it is still there (another process may have moved it). */
export async function sendHome(
  q: Queryable,
  here: string,
  home: string,
  at: number
): Promise<void> {
  await q.query(
    'update court_presence set world = $2, at = $3, called_by = null where id = 1 and world = $1',
    [here, home, new Date(at)]
  )
}
