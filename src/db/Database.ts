import pg from 'pg'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { migrate } from './schema'

/**
 * The court's Postgres (DATABASE_URL, one server per machine: compose.db.yaml). Every court
 * process and the admin open a small pool of their own; the schema is brought up to date by
 * whoever connects first (schema.ts). Without DATABASE_URL there is no database and the court
 * keeps everything in files, as it always has.
 */

/** Anything that runs a query: the database, or one transaction in it. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>
}

/** What the court needs of Postgres: `postgres()` for the real one, PGlite in the tests. */
export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>
  end(): Promise<void>
}

/** A pool on the real server. `name` shows in pg_stat_activity (the admin's list of who is in). */
export function postgres(url: string, name: string, log: Logger): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: name,
  })
  // An idle client that loses its server reports it here; with nobody listening it would throw.
  pool.on('error', (err) => log.debug(`database: ${errMsg(err)}`))
  const query = async <T>(text: string, params?: unknown[]) => ({
    rows: (await pool.query(text, params)).rows as T[],
  })
  return {
    query,
    async transaction(work) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await work({
          query: async <T>(text: string, params?: unknown[]) => ({
            rows: (await client.query(text, params)).rows as T[],
          }),
        })
        await client.query('commit')
        return result
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    end: () => pool.end(),
  }
}

const RETRY_MS = 30_000

/**
 * Open the database and bring its schema up to date. The court must play whether or not Postgres
 * is up, so this never fails: `ready` resolves once the database has answered (it tries again
 * every 30 s, saying so once per new reason).
 */
export function openDatabase(
  url: string,
  name: string,
  log: Logger
): { db: Database; ready: Promise<void> } {
  const db = postgres(url, name, log)
  const ready = (async () => {
    let said = ''
    for (;;) {
      try {
        const applied = await migrate(db)
        if (applied.length) log.info(`database: schema brought up to date (${applied.join(', ')})`)
        log.info(`database: connected${said ? ' again' : ''}`)
        return
      } catch (err) {
        const why = errMsg(err)
        if (why !== said) log.warn(`database not reachable (${why}); trying again every 30 s`)
        said = why
        await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    }
  })()
  return { db, ready }
}

/** Where a court process finds its database (DATABASE_URL), if it has one. */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined
}
