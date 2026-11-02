import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import type { Database, Queryable } from './Database'

/**
 * Where one of the court's shared stores (memories, orders, rules, hails, where the court is)
 * keeps what it holds: a file, or the database. Either way the store reads its data at once, from
 * memory, and sees what another process changed: the other world's court, the other mind, the
 * admin.
 */
export interface Keeper<T> {
  /** The data as last seen. */
  read(): T
  /**
   * Change the data: `change` does it here (returning false when there was nothing to change),
   * `write` does the same in the database. A file keeper writes the whole file instead.
   */
  update(change: (data: T) => boolean | void, write: (tx: Queryable) => Promise<unknown>): void
}

/** A store kept in the database: the process's shared state, and whose store it is. */
export interface InDatabase {
  shared: SharedState
  /** The courtier the store belongs to (memories, orders, hails). */
  bot?: string
}

export function inDatabase(where: unknown): where is InDatabase {
  return typeof where === 'object' && where !== null && 'shared' in where
}

/** A JSON file, read again when someone else changed it. No file: kept in memory only (tests). */
export class FileKeeper<T> implements Keeper<T> {
  private data: T
  private mtime = 0
  private checkedAt = 0

  constructor(
    private readonly file: string | undefined,
    private readonly parse: (raw: unknown) => T,
    empty: () => T,
    private readonly opts: {
      /** Looked at for changes made elsewhere at most this often (always before a change). */
      checkMs?: number
      /** Written to a new file renamed over the old one: a reader never sees half of it. */
      atomic?: boolean
    } = {}
  ) {
    this.data = empty()
    this.fresh(true)
  }

  read(): T {
    return this.fresh()
  }

  update(change: (data: T) => boolean | void): void {
    if (change(this.fresh(true)) === false) return
    this.save()
  }

  private fresh(force = false): T {
    if (!this.file) return this.data
    const now = Date.now()
    if (!force && now - this.checkedAt < (this.opts.checkMs ?? 0)) return this.data
    this.checkedAt = now
    try {
      const mtime = fs.statSync(this.file).mtimeMs
      if (mtime === this.mtime) return this.data
      this.mtime = mtime
      this.data = this.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch {
      // Not written yet, or half written: keep what is in memory rather than crash or forget.
    }
    return this.data
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const text = JSON.stringify(this.data, null, 2)
    if (this.opts.atomic) {
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, this.file)
    } else fs.writeFileSync(this.file, text)
    this.mtime = fs.statSync(this.file).mtimeMs
  }
}

/** One scope's data in this process, as the database holds it (see SharedState). */
class Replica<T> implements Keeper<T> {
  data: T
  /** The scope's version when last loaded; undefined: not loaded yet. */
  seen?: string
  /** Changes made here; a load begun before one is thrown away. */
  changes = 0
  /** This scope's writes still waiting. */
  waiting = 0

  constructor(
    readonly scope: string,
    readonly load: (q: Queryable) => Promise<T>,
    empty: () => T,
    private readonly owner: SharedState
  ) {
    this.data = empty()
  }

  read(): T {
    return this.data
  }

  update(change: (data: T) => boolean | void, write: (tx: Queryable) => Promise<unknown>): void {
    if (change(this.data) === false) return
    this.changes++
    this.owner.enqueue(this as Replica<unknown>, write)
  }
}

/** Every change to a scope bumps its version; the processes that hold it load it again. */
export async function bump(q: Queryable, scope: string): Promise<void> {
  await q.query(
    `insert into court_versions (scope, version) values ($1, 1)
     on conflict (scope) do update set version = court_versions.version + 1, at = now()`,
    [scope]
  )
}

const POLL_MS = 2_000
const RETRY_MS = 5_000
const MAX_WAITING = 5_000

/**
 * A process's copy of the court's shared state in the database (DATABASE_URL). Each store holds
 * its data in memory, so reading never waits; a change is made here at once and written in the
 * background, in order, with its scope's version bumped (`court_versions`). Every two seconds the
 * process asks for the versions and loads again whatever another process changed. While the
 * database is away the court plays on with what it holds, and the changes wait (and are lost
 * only if the process stops before it is back).
 */
export class SharedState {
  private readonly replicas = new Map<string, Replica<unknown>>()
  private readonly queue: Array<{
    replica: Replica<unknown>
    write: (tx: Queryable) => Promise<unknown>
  }> = []
  private writing?: Promise<void>
  private polling?: Promise<void>
  private timer?: NodeJS.Timeout
  private down = ''
  private writeDown = ''
  private firstLoad!: () => void
  /** Resolves once everything was loaded the first time. */
  readonly loaded = new Promise<void>((resolve) => (this.firstLoad = resolve))
  private begun!: () => void
  /** The database answered and the old files were taken in (see `before`). */
  private readonly started = new Promise<void>((resolve) => (this.begun = resolve))

  constructor(
    private readonly db: Database,
    private readonly ready: Promise<void>,
    private readonly log: Logger,
    private readonly opts: {
      /** Done once the database answers, before anything is loaded or written (the import). */
      before?: () => Promise<void>
      pollMs?: number
      retryMs?: number
    } = {}
  ) {}

  /** The keeper of one scope ("memory:merlin"); stores of one scope in a process share it. */
  replica<T>(scope: string, load: (q: Queryable) => Promise<T>, empty: () => T): Keeper<T> {
    const known = this.replicas.get(scope)
    if (known) return known as Replica<T>
    const made = new Replica<T>(scope, load, empty, this)
    this.replicas.set(scope, made as Replica<unknown>)
    return made
  }

  /** Changes not yet in the database. */
  get pending(): number {
    return this.queue.length
  }

  start(): void {
    void (async () => {
      await this.ready
      while (this.opts.before) {
        try {
          await this.opts.before()
          break
        } catch (err) {
          this.log.warn(`shared state: the old files could not be taken in (${errMsg(err)})`)
          await sleep(this.opts.retryMs ?? RETRY_MS)
        }
      }
      this.begun()
      await this.sync()
      this.timer = setInterval(() => void this.sync(), this.opts.pollMs ?? POLL_MS)
      this.timer.unref()
      void this.flush()
    })()
  }

  /** Write what waits (at most a few seconds when stopping). */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    await Promise.race([this.flush(), sleep(3_000)])
    if (this.queue.length)
      this.log.warn(`shared state: ${this.queue.length} change(s) not written before stopping`)
  }

  /** Load again every scope another process changed (every two seconds by itself). */
  sync(): Promise<void> {
    this.polling ??= this.poll().finally(() => (this.polling = undefined))
    return this.polling
  }

  enqueue(replica: Replica<unknown>, write: (tx: Queryable) => Promise<unknown>): void {
    replica.waiting++
    this.queue.push({ replica, write })
    if (this.queue.length > MAX_WAITING) {
      const gone = this.queue.shift()
      if (gone) gone.replica.waiting--
      this.log.warn('shared state: too many changes wait for the database; the oldest is dropped')
    }
    void this.flush()
  }

  /** Write every change that waits. */
  flush(): Promise<void> {
    this.writing ??= this.write().finally(() => (this.writing = undefined))
    return this.writing
  }

  private async write(): Promise<void> {
    await this.started
    while (this.queue.length) {
      const next = this.queue[0]
      try {
        await this.db.transaction(async (tx) => {
          await next.write(tx)
          await bump(tx, next.replica.scope)
        })
        if (this.writeDown) this.log.info('shared state: writing again')
        this.writeDown = ''
      } catch (err) {
        const why = errMsg(err)
        if (transient(err)) {
          if (why !== this.writeDown)
            this.log.warn(`shared state: cannot write (${why}); the changes wait`)
          this.writeDown = why
          await sleep(this.opts.retryMs ?? RETRY_MS)
          continue
        }
        this.log.error(`shared state: a change to ${next.replica.scope} was refused (${why})`)
      }
      this.queue.shift()
      next.replica.waiting--
    }
  }

  private async poll(): Promise<void> {
    try {
      const { rows } = await this.db.query<{ scope: string; version: string }>(
        'select scope, version::text as version from court_versions where scope = any($1)',
        [[...this.replicas.keys()]]
      )
      const versions = new Map(rows.map((r) => [r.scope, String(r.version)]))
      for (const r of this.replicas.values()) {
        const version = versions.get(r.scope) ?? '0'
        // A scope with changes of our own on the way is loaded once they are in.
        if (r.seen === version || r.waiting) continue
        const changes = r.changes
        const data = await r.load(this.db)
        if (r.changes !== changes || r.waiting) continue
        r.data = data
        r.seen = version
      }
      if (this.down) this.log.info('shared state: the database answers again')
      this.down = ''
      this.firstLoad()
    } catch (err) {
      const why = errMsg(err)
      if (why !== this.down)
        this.log.warn(`shared state: cannot load (${why}); the court plays on with what it holds`)
      this.down = why
    }
  }
}

/**
 * Worth trying again: the server is away or busy. Postgres's own refusals (a five-character
 * SQLSTATE) will not change by trying again, except a lost connection (08), too many connections
 * (53), a server shutting down (57P) or a transaction to retry (40).
 */
export function transient(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return /^(08|53|57P|40)/.test(code)
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

/**
 * A change made outside the court's stores (the admin): in one transaction with its scope's
 * version bumped, so every court process holding the scope loads it again.
 */
export function changeShared<T>(
  db: Database,
  scope: string,
  work: (tx: Queryable) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await work(tx)
    await bump(tx, scope)
    return result
  })
}
