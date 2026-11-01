import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseBackupStep, databaseStatus, dumpTarget } from '../admin/database'
import { AdminStore } from '../admin/store'
import { createLogger } from '../logger'
import { insertAudit, readAudit } from './audit'
import type { Database } from './Database'
import { History, WITHHELD, insertHistory, pruneHistory, readHistory } from './history'
import { MIGRATIONS, migrate } from './schema'

/** A real Postgres in this process (PGlite), dressed as the court's Database. */
function testDb(): Database {
  const pg = new PGlite()
  return {
    query: async <T>(text: string, params?: unknown[]) => ({
      rows: (await pg.query<T>(text, params)).rows,
    }),
    transaction: (work) =>
      pg.transaction((tx) =>
        work({
          query: async <T>(text: string, params?: unknown[]) => ({
            rows: (await tx.query<T>(text, params)).rows,
          }),
        })
      ),
    end: () => pg.close(),
  }
}

const log = createLogger('test')
const opts = { world: 'dev', division: 'household', chatDays: 7, keepDays: 30 }
const DAY = 24 * 60 * 60_000
// One database for every test here (each takes a few seconds to start), emptied between them.
let db: Database

beforeAll(async () => {
  db = testDb()
  expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.id))
}, 60_000)

afterAll(() => db.end())

beforeEach(async () => {
  await db.query('truncate court_history, admin_audit restart identity')
})

async function ready(): Promise<Database> {
  return db
}

describe('the schema', () => {
  it('is brought up to date once', async () => {
    expect(await migrate(db)).toEqual([])
    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from schema_migrations'
    )
    expect(rows[0].n).toBe(MIGRATIONS.length)
  })
})

describe('the history', () => {
  it('writes what it hears and reads it back newest first', async () => {
    const d = await ready()
    const h = new History(d, Promise.resolve(), opts, log)
    h.add({ kind: 'chat', actor: 'Alice', text: 'hello Merlin' }, 1_000)
    h.add({ kind: 'chat', actor: 'Merlin', text: 'Greetings!', data: { bot: true } }, 2_000)
    h.add({ kind: 'magic', actor: 'Merlin', target: 'Alice', text: 'Portal to home' }, 3_000)
    await h.flush(3_000)
    expect(h.backlog).toBe(0)
    const rows = await readHistory(d, {})
    expect(rows.map((r) => r.text)).toEqual(['Portal to home', 'Greetings!', 'hello Merlin'])
    expect(rows[1]).toMatchObject({ world: 'dev', actor: 'Merlin', data: { bot: true } })
    expect(rows[2].at).toBe(1_000)
  })

  it('writes a line every bot heard once', async () => {
    const d = await ready()
    const h = new History(d, Promise.resolve(), opts, log)
    h.add({ kind: 'chat', actor: 'Alice', text: 'hi' }, 1_000)
    h.add({ kind: 'chat', actor: 'Alice', text: 'hi' }, 1_500)
    h.add({ kind: 'chat', actor: 'Alice', text: 'hi' }, 9_000)
    await h.flush(9_000)
    expect(await readHistory(d, {})).toHaveLength(2)
  })

  it('never writes down a password', async () => {
    const d = await ready()
    const h = new History(d, Promise.resolve(), opts, log)
    h.add({ kind: 'chat', actor: 'Alice', text: 'my password is hunter2' })
    await h.flush()
    expect((await readHistory(d, {}))[0].text).toBe(WITHHELD)
  })

  it('keeps the lines while the database is away', async () => {
    const d = await ready()
    let fail = true
    const flaky: Database = {
      ...d,
      query: (text, params) => (fail ? Promise.reject(new Error('down')) : d.query(text, params)),
    }
    const h = new History(flaky, Promise.resolve(), opts, log)
    h.add({ kind: 'notice', text: 'Alice joined the game' })
    await h.flush()
    expect(h.backlog).toBe(1)
    fail = false
    await h.flush()
    expect(h.backlog).toBe(0)
    expect(await readHistory(d, {})).toHaveLength(1)
  })

  it('filters by world, kind, name and words, and pages', async () => {
    const d = await ready()
    await insertHistory(
      d,
      [
        { kind: 'chat', actor: 'Alice', text: 'where is my 100% horse?', at: 1 },
        { kind: 'chat', actor: 'Bob', target: 'Merlin', text: 'a secret', at: 2 },
        { kind: 'order', actor: 'Alice', target: 'Bruce', text: 'guard the gate', at: 3 },
      ],
      opts
    )
    await insertHistory(d, [{ kind: 'chat', actor: 'Alice', text: 'creative', at: 4 }], {
      world: 'creative',
      division: 'household',
    })
    expect(await readHistory(d, { world: 'creative' })).toHaveLength(1)
    expect((await readHistory(d, { kind: 'order' }))[0].text).toBe('guard the gate')
    expect(await readHistory(d, { who: 'merl' })).toHaveLength(1)
    expect(await readHistory(d, { q: '100%' })).toHaveLength(1)
    expect(await readHistory(d, { q: '_' })).toHaveLength(0)
    const first = await readHistory(d, { limit: 2 })
    const next = await readHistory(d, { limit: 2, before: first[1].id })
    expect(next.map((r) => r.text)).toEqual(['a secret', 'where is my 100% horse?'])
    expect(await readHistory(d, { after: next[0].id })).toHaveLength(2)
  })

  it('lets talk go after a week and the rest after a month, in its own world only', async () => {
    const d = await ready()
    const now = 100 * DAY
    await insertHistory(
      d,
      [
        { kind: 'chat', actor: 'Alice', text: 'old talk', at: now - 8 * DAY },
        { kind: 'chat', actor: 'Alice', text: 'new talk', at: now - DAY },
        { kind: 'magic', actor: 'Merlin', text: 'old spell', at: now - 8 * DAY },
        { kind: 'magic', actor: 'Merlin', text: 'ancient spell', at: now - 31 * DAY },
      ],
      opts
    )
    await insertHistory(d, [{ kind: 'chat', text: 'other world', at: now - 8 * DAY }], {
      world: 'creative',
      division: 'household',
    })
    expect(await pruneHistory(d, opts, now)).toBe(2)
    expect((await readHistory(d, {})).map((r) => r.text).sort()).toEqual([
      'new talk',
      'old spell',
      'other world',
    ])
  })
})

describe("the admin's audit log", () => {
  it('goes in and comes back newest first', async () => {
    await insertAudit(db, [
      { at: 1_000, ip: '10.0.0.5', action: 'signed in' },
      { at: 2_000, ip: '10.0.0.5', action: 'changed the bots', detail: ['Merlin'] },
    ])
    expect(await readAudit(db)).toEqual([
      { at: 2_000, ip: '10.0.0.5', action: 'changed the bots', detail: ['Merlin'] },
      { at: 1_000, ip: '10.0.0.5', action: 'signed in' },
    ])
  })

  it('takes in the lines its file kept while the database was away', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtbk-audit-'))
    try {
      const store = new AdminStore(dir, { ollama: [], password: 'a long password' }, () => {})
      store.audit({ ip: '10.0.0.5', action: 'before the database' })
      let open!: () => void
      store.useDatabase(db, new Promise<void>((r) => (open = r)), () => {})
      store.audit({ ip: '10.0.0.5', action: 'still before' })
      open()
      await new Promise((r) => setTimeout(r, 50))
      store.audit({ ip: '10.0.0.7', action: 'with the database' })
      await new Promise((r) => setTimeout(r, 50))
      expect((await store.auditLog()).map((e) => e.action)).toEqual([
        'with the database',
        'still before',
        'before the database',
      ])
      expect(fs.existsSync(path.join(dir, 'audit.log'))).toBe(false)
      expect(fs.readFileSync(path.join(dir, 'audit.imported.log'), 'utf8')).toContain(
        'still before'
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the admin's database page", () => {
  it('shows the tables, the history and the migrations', async () => {
    await insertHistory(db, [{ kind: 'chat', actor: 'Alice', text: 'hello', at: 5_000 }], opts)
    const s = await databaseStatus(db)
    expect(s).toMatchObject({ configured: true, up: true })
    expect(s.version).toMatch(/^PostgreSQL \d+/)
    expect(s.tables?.map((t) => t.name)).toEqual(
      expect.arrayContaining(['admin_audit', 'court_history', 'schema_migrations'])
    )
    expect(s.history).toEqual([
      { world: 'dev', kind: 'chat', count: 1, oldest: 5_000, newest: 5_000 },
    ])
    expect(s.migrations?.map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id))
  })

  it('says so when there is no database, or it does not answer', async () => {
    expect(await databaseStatus(undefined)).toEqual({ configured: false, up: false })
    const away: Database = { ...db, query: () => Promise.reject(new Error('refused')) }
    expect(await databaseStatus(away)).toEqual({ configured: true, up: false, error: 'refused' })
  })

  it("dumps as the URL's user, into the backups folder", () => {
    expect(dumpTarget('postgres://court:s3cret@127.0.0.1:5432/court')).toEqual({
      user: 'court',
      database: 'court',
    })
    expect(() => dumpTarget('postgres://x;rm@127.0.0.1/court')).toThrow()
    const { file, step } = databaseBackupStep(
      'postgres://court:s3cret@127.0.0.1:5432/court',
      'goodtobeking-db',
      '/backups'
    )
    expect(path.basename(file)).toMatch(/^database-\d{8}-\d{4}\.dump$/)
    expect(step.args).toEqual([
      'exec',
      'goodtobeking-db',
      'pg_dump',
      '-U',
      'court',
      '-d',
      'court',
      '-Fc',
    ])
    expect(step.args.join(' ')).not.toContain('s3cret')
  })
})
