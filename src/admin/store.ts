import fs from 'node:fs'
import path from 'node:path'
import { hashPassword, newPassword } from './auth'
import { readJson, writeJson } from './files'
import type { OllamaService } from './ollama'

/**
 * The admin's own data (ADMIN_DATA, a host folder): its password hash, the Ollama servers it
 * knows, and an audit log of every change made through it.
 */
export interface AdminData {
  passwordHash: string
  /** The password is still the one made at first start (its file is in the data folder). */
  firstPassword?: boolean
  ollama: OllamaService[]
}

export interface AuditEntry {
  at: number
  ip: string
  action: string
  detail?: unknown
}

export class AdminStore {
  private data: AdminData

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

  audit(entry: Omit<AuditEntry, 'at'>): void {
    const line = JSON.stringify({ at: Date.now(), ...entry })
    fs.appendFileSync(path.join(this.dir, 'audit.log'), line + '\n')
  }

  /** The newest entries first. */
  auditLog(limit = 500): AuditEntry[] {
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
