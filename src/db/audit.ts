import type { Queryable } from './Database'

/** One change made through the admin (who, from where, what). */
export interface AuditEntry {
  at: number
  ip: string
  action: string
  detail?: unknown
}

export async function insertAudit(db: Queryable, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return
  const values = entries
    .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(', ')
  await db.query(
    `insert into admin_audit (at, ip, action, detail) values ${values}`,
    entries.flatMap((e) => [
      new Date(e.at),
      e.ip,
      e.action,
      e.detail === undefined ? null : JSON.stringify(e.detail),
    ])
  )
}

/** The newest entries first. */
export async function readAudit(db: Queryable, limit = 500): Promise<AuditEntry[]> {
  const { rows } = await db.query<{
    at: Date | string
    ip: string
    action: string
    detail: unknown
  }>('select at, ip, action, detail from admin_audit order by at desc, id desc limit $1', [limit])
  return rows.map((r) => ({
    at: new Date(r.at).getTime(),
    ip: r.ip,
    action: r.action,
    ...(r.detail !== null && r.detail !== undefined ? { detail: r.detail } : {}),
  }))
}
