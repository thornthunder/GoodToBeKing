import fs from 'node:fs'
import path from 'node:path'
import { insertAudit, readAudit, type AuditEntry } from '../db/audit'
import type { Database } from '../db/Database'
import { errMsg } from '../util'
import { hashPassword, newPassword } from './auth'
import { readJson, writeJson } from './files'
import type { OllamaService } from './ollama'

/**
 * The admin's own data (ADMIN_DATA, a host folder): its password hash, the Ollama servers it
 * knows, and an audit log of every change made through it (in the database when there is one;
 * in audit.log while it is away, whose lines go in once it answers).
 */
export interface AdminData {
  passwordHash: string
  /** The password is still the one made at first start (its file is in the data folder). */
  firstPassword?: boolean
  ollama: OllamaService[]
}

export type { AuditEntry }

export class AdminStore {
  private data: AdminData
  private database?: Database
  private importing = false

  constructor(
    readonly dir: string,
    seed: { ollama: OllamaService[]; password?: string },
    log: (text: string) => void
  ) {
    fs.mkdirSync(dir, { recursive: true })
    const saved = readJson<AdminData>(this.file)
    if (saved?.passwordHash) this.data = { ...saved, ollama: saved.ollama ?? seed.ollama }
    else if (seed.password)
      this.data = { passwordHash: hashPassword(seed.password), ollama: seed.ollama }
    else {
      // First start without ADMIN_PASSWORD: a password of its own, in a file only the host's
      // user reads (and the log says where), until it is changed on the Admin page.
      const password = newPassword()
      const first = path.join(dir, 'first-password.txt')
      fs.writeFileSync(first, password + '\n', { mode: 0o600 })
      this.data = { passwordHash: hashPassword(password), firstPassword: true, ollama: seed.ollama }
      log(`no password yet: the first one is in ${first} (change it on the Admin page)`)
    }
    this.save()
  }

  private get file(): string {
    return path.join(this.dir, 'admin.json')
  }

  get(): AdminData {
    return { ...this.data, ollama: [...this.data.ollama] }
  }

  setPassword(password: string): void {
    this.data = { ...this.data, passwordHash: hashPassword(password), firstPassword: false }
    fs.rmSync(path.join(this.dir, 'first-password.txt'), { force: true })
    this.save()
  }

  setOllama(services: OllamaService[]): void {
    this.data = { ...this.data, ollama: services }
    this.save()
  }

  private save(): void {
    writeJson(this.file, this.data)
    fs.chmodSync(this.file, 0o600)
  }

  /** Keep the audit log in the database once it answers. */
  useDatabase(db: Database, ready: Promise<void>, log: (text: string) => void): void {
    void ready.then(async () => {
      this.database = db
      await this.importAuditFile().catch((err) =>
        log(`audit: the file's lines did not go in (${errMsg(err)})`)
      )
    })
  }

  audit(entry: Omit<AuditEntry, 'at'>): void {
    const full: AuditEntry = { at: Date.now(), ...entry }
    const db = this.database
    if (!db) return this.auditToFile([full])
    void insertAudit(db, [full])
      .then(() => this.importAuditFile())
      .catch(() => this.auditToFile([full]))
  }

  private get auditFile(): string {
    return path.join(this.dir, 'audit.log')
  }

  private auditToFile(entries: AuditEntry[]): void {
    fs.appendFileSync(this.auditFile, entries.map((e) => JSON.stringify(e) + '\n').join(''))
  }

  /** Lines written while the database was away go in (kept in audit.imported.log too). */
  private async importAuditFile(): Promise<void> {
    const db = this.database
    if (!db || this.importing || !fs.existsSync(this.auditFile)) return
    this.importing = true
    const moving = `${this.auditFile}.importing`
    try {
      fs.renameSync(this.auditFile, moving)
      const text = fs.readFileSync(moving, 'utf8')
      const entries = text
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as AuditEntry]
          } catch {
            return []
          }
        })
      try {
        await insertAudit(db, entries)
        fs.appendFileSync(path.join(this.dir, 'audit.imported.log'), text)
      } catch (err) {
        // Back into the file, to go in next time (the entries keep their times).
        this.auditToFile(entries)
        throw err
      } finally {
        fs.rmSync(moving, { force: true })
      }
    } finally {
      this.importing = false
    }
  }

  /** The newest entries first. */
  async auditLog(limit = 500): Promise<AuditEntry[]> {
    if (this.database) {
      try {
        return await readAudit(this.database, limit)
      } catch {
        // The database is away: what the file holds.
      }
    }
    try {
      const lines = fs.readFileSync(path.join(this.dir, 'audit.log'), 'utf8').trim().split('\n')
      return lines
        .slice(-limit)
        .reverse()
        .map((l) => JSON.parse(l) as AuditEntry)
    } catch {
      return []
    }
  }
}
