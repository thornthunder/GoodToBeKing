import fs from 'node:fs'
import path from 'node:path'
import { normalise, parseMemory } from '../ai/CourtMemory'
import { parseHails } from '../ai/HailLog'
import { parseBook, parseRules } from '../ai/orders'
import type { Logger } from '../logger'
import { parse as parsePresence } from '../presence'
import { insertFacts, insertReport, raiseCounter, setHail } from './court'
import type { Database, Queryable } from './Database'
import { bump } from './shared'

/** The import of the shared folder's files, done once (court_imports). */
export const IMPORT = 'shared-files'
/** Where the files go once they are in the database. */
export const IMPORTED_DIR = 'before-database'
/** Not the migrations' lock (schema.ts). */
const LOCK = 4_711_002

const MEMORY = /^memory-([a-z0-9_]+)\.json$/i
const ORDERS = /^orders-([a-z0-9_]+)\.json$/i
const HAILS = /^([a-z0-9_]+)\.hails\.json$/i

/**
 * Take the shared folder's files into the database, once, whoever comes first (the courts of both
 * worlds and both minds start together): memories, orders and reports, rules, hails and where the
 * court is. The files then go into `before-database/` (kept, to go back to them by hand). A file
 * that cannot be read is left where it is and named.
 */
export async function importSharedFiles(
  db: Database,
  dir: string,
  log: Logger,
  opts: { home: string }
): Promise<void> {
  const done = await db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [LOCK])
    const before = await tx.query('select 1 from court_imports where name = $1', [IMPORT])
    if (before.rows.length) return undefined
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    const taken: string[] = []
    const broken: string[] = []
    const counts = { facts: 0, orders: 0, reports: 0, rules: 0, hails: 0, presence: 0 }
    const read = (name: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      } catch {
        broken.push(name)
        return undefined
      }
    }
    for (const name of names) {
      let m: RegExpMatchArray | null
      if ((m = name.match(MEMORY))) {
        const raw = read(name)
        if (raw === undefined) continue
        const bot = m[1].toLowerCase()
        for (const [subject, facts] of Object.entries(parseMemory(raw))) {
          const fresh = new Set<string>()
          const rows = facts
            .map((f) => ({
              text: f.text,
              at: Number(f.at) || 0,
              ...(f.private ? { private: true } : {}),
              ...(f.secret ? { secret: true } : {}),
              norm: normalise(f.text),
            }))
            .filter((f) => {
              if (!f.norm || fresh.has(f.norm)) return false
              fresh.add(f.norm)
              return true
            })
          for (let i = 0; i < rows.length; i += 200)
            await insertFacts(tx, bot, subject.toLowerCase(), rows.slice(i, i + 200), 100_000)
          counts.facts += rows.length
        }
        await bump(tx, `memory:${bot}`)
      } else if ((m = name.match(ORDERS))) {
        const raw = read(name)
        if (raw === undefined) continue
        const bot = m[1].toLowerCase()
        const book = parseBook(raw)
        for (const o of book.orders) {
          await insertImportedOrder(tx, bot, o)
          counts.orders++
        }
        for (const text of book.reports) {
          await insertReport(tx, bot, text)
          counts.reports++
        }
        await raiseCounter(tx, `orders:${bot}`, book.next)
        await bump(tx, `orders:${bot}`)
      } else if ((m = name.match(HAILS))) {
        const raw = read(name)
        if (raw === undefined) continue
        const bot = m[1].toLowerCase()
        for (const [player, at] of Object.entries(parseHails(raw))) {
          await setHail(tx, bot, player.toLowerCase(), at)
          counts.hails++
        }
        await bump(tx, `hails:${bot}`)
      } else if (name === 'rules.json') {
        const raw = read(name)
        if (raw === undefined) continue
        const data = parseRules(raw)
        for (const r of data.rules) {
          await tx.query(
            `insert into court_rules (num, giver, giver_title, text, at) values ($1, $2, $3, $4, $5)
             on conflict (num) do nothing`,
            [Number(r.id.slice(1)) || 0, r.from, r.by, r.text, new Date(r.at || 0)]
          )
          counts.rules++
        }
        await raiseCounter(tx, 'rules', data.next)
        await bump(tx, 'rules')
      } else if (name === 'presence.json') {
        const raw = read(name)
        if (raw === undefined) continue
        const p = parsePresence(raw, opts.home)
        await tx.query(
          `insert into court_presence (id, world, at, called_by, king_seen)
           values (1, $1, $2, $3, $4::jsonb)
           on conflict (id) do update set world = excluded.world, at = excluded.at,
             called_by = excluded.called_by, king_seen = excluded.king_seen`,
          [p.world, p.at ? new Date(p.at) : null, p.by ?? null, JSON.stringify(p.kingSeen)]
        )
        counts.presence++
        await bump(tx, 'presence')
      } else continue
      taken.push(name)
    }
    await tx.query('insert into court_imports (name, detail) values ($1, $2)', [
      IMPORT,
      JSON.stringify({ dir, files: taken, broken, counts }),
    ])
    return { taken, broken, counts }
  })
  if (!done) return
  const away = path.join(dir, IMPORTED_DIR)
  if (done.taken.length) fs.mkdirSync(away, { recursive: true })
  for (const name of done.taken) {
    try {
      fs.renameSync(path.join(dir, name), path.join(away, name))
    } catch (err) {
      log.warn(`shared state: ${name} is in the database but stays in ${dir} (${String(err)})`)
    }
  }
  const c = done.counts
  log.info(
    `shared state: the files are in the database (${c.facts} facts, ${c.orders} orders, ` +
      `${c.reports} reports, ${c.rules} rules, ${c.hails} hails${c.presence ? ', where the court is' : ''}); ` +
      `the files went to ${away}`
  )
  if (done.broken.length)
    log.warn(`shared state: could not read ${done.broken.join(', ')}; left as they were`)
}

/** An order keeps its number (the file's ids go on). */
async function insertImportedOrder(
  tx: Queryable,
  bot: string,
  o: { id: string; from: string; by: string; text: string; post?: unknown; at: number }
): Promise<void> {
  await tx.query(
    `insert into court_orders (bot, num, giver, giver_title, text, post, at)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (bot, num) do nothing`,
    [
      bot,
      Number(o.id.slice(1)) || 0,
      o.from,
      o.by,
      o.text,
      o.post ? JSON.stringify(o.post) : null,
      new Date(o.at || 0),
    ]
  )
}
