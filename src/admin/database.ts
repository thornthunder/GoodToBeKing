import path from 'node:path'
import type { Database } from '../db/Database'
import { errMsg } from '../util'

/**
 * What the admin shows of the court's database (Services > Database): whether it answers, how big
 * it is, its tables, who is connected, the history it holds, and its migrations. Backups are
 * pg_dump in the database's own container (ADMIN_DB_CONTAINER), through the Docker socket.
 */
export interface DatabaseStatus {
  configured: boolean
  up: boolean
  error?: string
  version?: string
  sizeMb?: number
  tables?: Array<{ name: string; rows: number; sizeKb: number }>
  connections?: Array<{ name: string; state: string; count: number }>
  history?: Array<{ world: string; kind: string; count: number; oldest: number; newest: number }>
  migrations?: Array<{ id: number; what: string; at: number }>
}

const time = (v: unknown) => new Date(v as string | Date).getTime()

export async function databaseStatus(db: Database | undefined): Promise<DatabaseStatus> {
  if (!db) return { configured: false, up: false }
  const work = async (): Promise<DatabaseStatus> => {
    const [version, size, tables, connections, history, migrations] = await Promise.all([
      db.query<{ v: string }>('select version() as v'),
      db.query<{ n: string }>('select pg_database_size(current_database()) as n'),
      db.query<{ name: string; rows: string; size: string }>(
        `select relname as name, n_live_tup as rows, pg_total_relation_size(relid) as size
         from pg_stat_user_tables order by relname`
      ),
      db.query<{ name: string; state: string; count: number }>(
        `select coalesce(nullif(application_name, ''), '(unnamed)') as name,
                coalesce(state, '') as state, count(*)::int as count
         from pg_stat_activity where datname = current_database() group by 1, 2 order by 1, 2`
      ),
      db.query<{ world: string; kind: string; count: number; oldest: Date; newest: Date }>(
        `select world, kind, count(*)::int as count, min(at) as oldest, max(at) as newest
         from court_history group by world, kind order by world, kind`
      ),
      db.query<{ id: number; what: string; at: Date }>(
        'select id, what, at from schema_migrations order by id'
      ),
    ])
    return {
      configured: true,
      up: true,
      version: /PostgreSQL [\d.]+/.exec(version.rows[0]?.v ?? '')?.[0],
      sizeMb: Math.round(Number(size.rows[0]?.n ?? 0) / 1024 / 102.4) / 10,
      tables: tables.rows.map((t) => ({
        name: t.name,
        rows: Number(t.rows),
        sizeKb: Math.round(Number(t.size) / 1024),
      })),
      connections: connections.rows,
      history: history.rows.map((h) => ({
        world: h.world,
        kind: h.kind,
        count: h.count,
        oldest: time(h.oldest),
        newest: time(h.newest),
      })),
      migrations: migrations.rows.map((m) => ({ id: Number(m.id), what: m.what, at: time(m.at) })),
    }
  }
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('no answer within 5 s')), 5_000)
      ),
    ])
  } catch (err) {
    return { configured: true, up: false, error: errMsg(err) }
  }
}

/** The user and database a postgres:// URL names (pg_dump runs as them inside the container). */
export function dumpTarget(url: string): { user: string; database: string } {
  const u = new URL(url)
  const user = decodeURIComponent(u.username) || 'postgres'
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || user
  if (!/^[\w-]+$/.test(user) || !/^[\w-]+$/.test(database))
    throw new Error('the database URL names an odd user or database')
  return { user, database }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
}

/** The step that dumps the database into the backups folder (pg_dump's own compressed format). */
export function databaseBackupStep(
  url: string,
  container: string,
  dir: string
): { file: string; step: { cmd: string; args: string[]; out: string } } {
  const { user, database } = dumpTarget(url)
  const file = path.join(dir, `database-${stamp()}.dump`)
  return {
    file,
    step: {
      cmd: 'docker',
      args: ['exec', container, 'pg_dump', '-U', user, '-d', database, '-Fc'],
      out: file,
    },
  }
}
