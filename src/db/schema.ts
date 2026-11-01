import type { Queryable } from './Database'

/**
 * The database's schema, one migration after another. A migration is never changed once
 * deployed: a change is a new one at the end. They run in one transaction under an advisory lock,
 * so the court processes and the admin starting together do not race.
 */
export interface Migration {
  id: number
  what: string
  /** One statement each (PGlite, in the tests, runs one per query). */
  sql: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    what: "the court's history and the admin's audit log",
    sql: [
      `create table court_history (
        id bigserial primary key,
        at timestamptz not null default now(),
        world text not null default '',
        division text not null default '',
        kind text not null,
        actor text not null default '',
        target text not null default '',
        text text not null,
        data jsonb
      )`,
      'create index court_history_at on court_history (at)',
      'create index court_history_world_kind on court_history (world, kind, id)',
      `create table admin_audit (
        id bigserial primary key,
        at timestamptz not null default now(),
        ip text not null default '',
        action text not null,
        detail jsonb
      )`,
    ],
  },
]

/** Any number will do, as long as nothing else on the server takes the same lock. */
const LOCK = 4_711_001

/** Apply the migrations the database has not had yet; returns their ids. */
export async function migrate(db: {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>
}): Promise<number[]> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [LOCK])
    await tx.query(
      `create table if not exists schema_migrations (
        id integer primary key,
        what text not null,
        at timestamptz not null default now()
      )`
    )
    const done = new Set(
      (await tx.query<{ id: number }>('select id from schema_migrations')).rows.map((r) =>
        Number(r.id)
      )
    )
    const applied: number[] = []
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue
      for (const statement of m.sql) await tx.query(statement)
      await tx.query('insert into schema_migrations (id, what) values ($1, $2)', [m.id, m.what])
      applied.push(m.id)
    }
    return applied
  })
}
