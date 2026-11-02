import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CourtMemory } from '../ai/CourtMemory'
import { HailLog } from '../ai/HailLog'
import { CourtRules, OrderBook } from '../ai/orders'
import { createLogger } from '../logger'
import { AWAY_MS, Presence } from '../presence'
import { deleteFact, loadPresence, memorySizes } from './court'
import type { Database } from './Database'
import { IMPORTED_DIR, importSharedFiles } from './importFiles'
import { migrate } from './schema'
import { SharedState, changeShared, transient } from './shared'

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

/** The database as one process sees it, which can be made to go away. */
function flaky(db: Database): { db: Database; down: boolean } {
  const state = { down: false, db: undefined as unknown as Database }
  const check = () => {
    if (state.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  }
  state.db = {
    query: async (text, params) => (check(), db.query(text, params)),
    transaction: async (work) => (check(), db.transaction(work)),
    end: async () => {},
  }
  return state
}

const log = createLogger('test')
let db: Database
const opened: SharedState[] = []

beforeAll(async () => {
  db = testDb()
  await migrate(db)
}, 60_000)

afterAll(async () => {
  for (const s of opened) await s.stop()
  await db.end()
})

beforeEach(async () => {
  await db.query(
    `truncate court_versions, court_facts, court_counters, court_orders, court_reports,
     court_rules, court_hails, court_presence, court_imports restart identity`
  )
})

/** One court process's shared state, started (the poll is driven by hand). */
async function open(on: Database = db, before?: () => Promise<void>): Promise<SharedState> {
  const s = new SharedState(on, Promise.resolve(), log, { pollMs: 1e9, retryMs: 10, before })
  opened.push(s)
  s.start()
  await s.loaded
  return s
}

/** Changes written by one process, and seen by the others. */
async function settle(...processes: SharedState[]): Promise<void> {
  for (const p of processes) await p.flush()
  for (const p of processes) await p.sync()
}

describe('the shared state in the database', () => {
  it('shares a courtier’s memory between the worlds, each fact once', async () => {
    const dev = await open()
    const creative = await open()
    const here = new CourtMemory({ shared: dev, bot: 'Merlin' })
    const there = new CourtMemory({ shared: creative, bot: 'Merlin' })
    await settle(dev, creative)
    expect(here.add('LittleOne42', ['The Princess loves magenta.'])).toHaveLength(1)
    // Read at once, before the database has it.
    expect(here.facts('littleone42')).toEqual(['The Princess loves magenta.'])
    there.add('LittleOne42', ['the princess loves MAGENTA!', 'She has a cat called Biscuit.'])
    await settle(dev, creative)
    for (const m of [here, there])
      expect(m.facts('LittleOne42')).toEqual([
        'The Princess loves magenta.',
        'She has a cat called Biscuit.',
      ])
    expect((await memorySizes(db)).get('merlin')).toEqual({ subjects: 1, facts: 2 })
  })

  it('keeps the newest facts of a subject, as many as allowed', async () => {
    const s = await open()
    const memory = new CourtMemory({ shared: s, bot: 'Henry' }, 2)
    await s.sync()
    memory.add('x', ['one'], 1)
    memory.add('x', ['two'], 2)
    memory.add('x', ['three'], 3)
    await settle(s)
    expect(memory.facts('x')).toEqual(['two', 'three'])
    expect(
      await changeShared(db, 'memory:henry', (tx) =>
        deleteFact(tx, 'henry', 'x', { text: 'two', at: 2 })
      )
    ).toBe(true)
    await s.sync()
    expect(memory.facts('x')).toEqual(['three'])
  })

  it('never loses a change of its own to a load from before it', async () => {
    const s = await open()
    const memory = new CourtMemory({ shared: s, bot: 'Joan' })
    await s.sync()
    memory.add('x', ['a fact not yet written'])
    await s.sync()
    expect(memory.facts('x')).toEqual(['a fact not yet written'])
  })

  it('numbers the orders of a courtier in both worlds without giving a number twice', async () => {
    const dev = await open()
    const creative = await open()
    const a = new OrderBook({ shared: dev, bot: 'Merlin' })
    const b = new OrderBook({ shared: creative, bot: 'Merlin' })
    await settle(dev, creative)
    // Each world takes an order before it has seen the other's.
    expect(
      a.add({ from: 'BigDad', by: 'the King', text: 'Stay by the gate.', post: { type: 'stay' } })
        .id
    ).toBe('O1')
    expect(b.add({ from: 'LittleOne42', by: 'the Princess', text: 'Be cheerful.' }).id).toBe('O1')
    await settle(dev, creative)
    for (const book of [a, b])
      expect(book.orders.map((o) => `${o.id} ${o.text}`)).toEqual([
        'O1 Stay by the gate.',
        'O2 Be cheerful.',
      ])
    expect(a.post()?.post).toEqual({ type: 'stay' })
    b.remove(['O1'])
    await settle(dev, creative)
    expect(a.post()).toBeUndefined()
    // Numbering goes on: an old id never comes back.
    expect(a.add({ from: 'x', by: 'x', text: 'x' }).id).toBe('O3')
  })

  it('gives each report once, and forgets only those given', async () => {
    const s = await open()
    const other = await open()
    const book = new OrderBook({ shared: s, bot: 'Bruce' })
    const elsewhere = new OrderBook({ shared: other, bot: 'Bruce' })
    await settle(s, other)
    book.addReport('the King gave me an order: Stay by the gate.')
    await settle(s, other)
    elsewhere.addReport('the Prince gave me an order: Sing.')
    book.reported()
    await settle(s, other)
    expect(book.reports).toEqual(['the Prince gave me an order: Sing.'])
  })

  it('shares the royals’ rules with every process', async () => {
    const dev = await open()
    const army = await open()
    const rules = new CourtRules({ shared: dev })
    const theirs = new CourtRules({ shared: army })
    await settle(dev, army)
    rules.add({ from: 'BigDad', by: 'the King', text: 'Nobody digs in the garden.' })
    await settle(dev, army)
    expect(theirs.rules.map((r) => `${r.id} ${r.text}`)).toEqual(['R1 Nobody digs in the garden.'])
    theirs.remove(['R1'])
    await settle(dev, army)
    expect(rules.rules).toEqual([])
    expect(rules.add({ from: 'x', by: 'x', text: 'x' }).id).toBe('R2')
  })

  it('remembers hails, the later one winning', async () => {
    const dev = await open()
    const creative = await open()
    const a = new HailLog({ shared: dev, bot: 'Festaris' })
    const b = new HailLog({ shared: creative, bot: 'Festaris' })
    await settle(dev, creative)
    a.set('BigDad', 5_000)
    await settle(dev, creative)
    b.set('bigdad', 4_000)
    await settle(dev, creative)
    expect(a.get('BIGDAD')).toBe(5_000)
    expect(b.recent('BigDad', 2_000, 6_000)).toBe(true)
  })

  it('knows where the court is in both worlds', async () => {
    const devState = await open()
    const creativeState = await open()
    const dev = new Presence({ shared: devState }, 'dev', 'dev')
    const creative = new Presence({ shared: creativeState }, 'creative', 'dev')
    await settle(devState, creativeState)
    expect(dev.courtHere()).toBe(true)
    creative.callHere('King', 1_000)
    expect(creative.courtHere()).toBe(true)
    await settle(devState, creativeState)
    expect(dev.world).toBe('creative')
    expect(dev.calledBy).toEqual({ by: 'King', at: 1_000 })
    creative.noteKing(10 * 60_000)
    expect(creative.returnIfForgotten(10 * 60_000 + AWAY_MS - 1)).toBe(false)
    expect(creative.returnIfForgotten(10 * 60_000 + AWAY_MS)).toBe(true)
    await settle(devState, creativeState)
    expect(dev.courtHere()).toBe(true)
    expect((await loadPresence(db))?.kingSeen).toEqual({ creative: 10 * 60_000 })
  })

  it('plays on while the database is away, and writes once it is back', async () => {
    const line = flaky(db)
    const s = await open(line.db)
    const memory = new CourtMemory({ shared: s, bot: 'Wat' })
    await s.sync()
    line.down = true
    memory.add('x', ['The field needs water.'])
    await s.sync()
    expect(memory.facts('x')).toEqual(['The field needs water.'])
    expect(s.pending).toBe(1)
    line.down = false
    await settle(s)
    expect(s.pending).toBe(0)
    expect(new Set((await memorySizes(db)).keys())).toEqual(new Set(['wat']))
  })

  it('tells a lost connection from a refusal', () => {
    expect(transient(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(transient(Object.assign(new Error('x'), { code: '08006' }))).toBe(true)
    expect(transient(Object.assign(new Error('x'), { code: '23505' }))).toBe(false)
  })
})

describe('taking in the shared folder', () => {
  it('takes the files in once and puts them aside', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtbk-shared-'))
    try {
      const write = (name: string, data: unknown) =>
        fs.writeFileSync(path.join(dir, name), JSON.stringify(data))
      write('memory-merlin.json', {
        littleone42: [
          { text: 'The Princess loves magenta.', at: 1_000 },
          { text: 'She is seven years old.', at: 2_000, private: true },
        ],
        bigdad: [{ text: 'The King hums when he builds.', at: 3_000, secret: true }],
      })
      write('orders-bruce.json', {
        next: 5,
        orders: [
          {
            id: 'O4',
            from: 'BigDad',
            by: 'the King',
            text: 'Guard the gate.',
            post: { type: 'stay' },
            at: 4_000,
          },
        ],
        reports: ['the King gave me an order: Guard the gate.'],
      })
      write('rules.json', {
        next: 3,
        rules: [{ id: 'R2', from: 'BigDad', by: 'the King', text: 'No digging.', at: 5_000 }],
      })
      write('Merlin.hails.json', { bigdad: 6_000 })
      write('presence.json', {
        world: 'creative',
        at: 7_000,
        by: 'BigDad',
        kingSeen: { creative: 8_000 },
      })
      fs.writeFileSync(path.join(dir, 'memory-broken.json'), '{half')
      write('bots.edits.json', {})

      const s = await open(db, () => importSharedFiles(db, dir, log, { home: 'dev' }))
      const memory = new CourtMemory({ shared: s, bot: 'Merlin' })
      const orders = new OrderBook({ shared: s, bot: 'Bruce' })
      const rules = new CourtRules({ shared: s })
      const hails = new HailLog({ shared: s, bot: 'Merlin' })
      const presence = new Presence({ shared: s }, 'dev', 'dev')
      await s.sync()
      expect(memory.entries('littleone42')).toEqual([
        { text: 'The Princess loves magenta.', at: 1_000 },
        { text: 'She is seven years old.', at: 2_000, private: true },
      ])
      expect(memory.entries('bigdad')[0].secret).toBe(true)
      expect(orders.post()).toMatchObject({ id: 'O4', text: 'Guard the gate.' })
      expect(orders.reports).toEqual(['the King gave me an order: Guard the gate.'])
      expect(orders.add({ from: 'x', by: 'x', text: 'x' }).id).toBe('O5')
      expect(rules.rules.map((r) => r.id)).toEqual(['R2'])
      expect(rules.add({ from: 'x', by: 'x', text: 'x' }).id).toBe('R3')
      expect(hails.get('BigDad')).toBe(6_000)
      expect(presence.world).toBe('creative')
      expect(presence.calledBy).toEqual({ by: 'BigDad', at: 7_000 })

      // Put aside; what could not be read, and what is not the court's, stay.
      expect(fs.readdirSync(dir).sort()).toEqual([
        IMPORTED_DIR,
        'bots.edits.json',
        'memory-broken.json',
      ])
      expect(fs.readdirSync(path.join(dir, IMPORTED_DIR))).toHaveLength(5)
      // Whoever comes second finds it done.
      write('memory-merlin.json', { x: [{ text: 'new', at: 1 }] })
      await importSharedFiles(db, dir, log, { home: 'dev' })
      expect((await memorySizes(db)).get('merlin')?.facts).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
