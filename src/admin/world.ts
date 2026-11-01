import fs from 'node:fs'
import path from 'node:path'
import { applyBotEdits, readBotEdits, type BotEdits } from '../botEdits'
import type { CourtStatus } from '../status'
import { EnvFile } from './envfile'
import { appendLine, inside, readJson, writeWhole } from './files'
import { run } from './jobs'
import { invalid } from './settings'

/**
 * One world's court as the admin sees it: a checkout of this repository on the host (its .env,
 * config, .state and compose files) and the containers compose runs from it. The admin mounts
 * each checkout at the same path it has on the host, so compose inside the admin works as it
 * does in a shell on the host.
 */
export interface WorldDef {
  /** A short id, e.g. "dev" (the page's links). */
  id: string
  /** The checkout's folder on the host (and in the admin's container). */
  dir: string
  /** Shown on the pages, e.g. "Dev world". */
  label?: string
}

export type Division = 'household' | 'army'

export interface Container {
  name: string
  service: string
  state: string
  status: string
  image: string
}

const STALE_MS = 20_000

export class World {
  constructor(readonly def: WorldDef) {}

  get id(): string {
    return this.def.id
  }

  get dir(): string {
    return this.def.dir
  }

  get label(): string {
    const world = this.env().get('COURT_WORLD')
    return (
      this.def.label ?? (world ? `${world[0].toUpperCase()}${world.slice(1)} world` : this.def.id)
    )
  }

  /** Whether the checkout is there (mounted into the admin's container). */
  exists(): boolean {
    return fs.existsSync(path.join(this.dir, 'compose.yaml'))
  }

  // ---- Settings ------------------------------------------------------------------------------

  envPath(): string {
    return path.join(this.dir, '.env')
  }

  env(): EnvFile {
    try {
      return new EnvFile(fs.readFileSync(this.envPath(), 'utf8'))
    } catch {
      return new EnvFile('')
    }
  }

  /** Change settings; each checked first. They reach the court when its containers are made again. */
  saveEnv(changes: Record<string, string | undefined>): void {
    const problems = Object.entries(changes)
      .map(([k, v]) => [k, v === undefined ? undefined : invalid(k, v)] as const)
      .filter(([, p]) => p)
      .map(([k, p]) => `${k}: ${p}`)
    if (problems.length) throw new Error(problems.join('; '))
    const env = this.env()
    for (const [k, v] of Object.entries(changes)) env.set(k, v)
    if (fs.existsSync(this.envPath())) fs.copyFileSync(this.envPath(), `${this.envPath()}.bak`)
    writeWhole(this.envPath(), env.toString())
  }

  // ---- Files ---------------------------------------------------------------------------------

  /** A file of the checkout named in a setting (relative to it), or the default. */
  private configured(key: string, fallback: string): string {
    return inside(this.dir, this.env().get(key) || fallback)
  }

  botsPath(): string {
    return this.configured('BOTS_FILE', 'config/bots.json')
  }

  courtPath(): string {
    return this.configured('COURT_FILE', 'config/court.json')
  }

  stateDir(): string {
    return path.join(this.dir, '.state')
  }

  state(name: string): string {
    return inside(this.stateDir(), name)
  }

  /** The folder both worlds share (COURT_SHARED on the host), else the checkout's own. */
  sharedDir(): string {
    const shared = this.env().get('COURT_SHARED')
    return shared ? path.resolve(shared) : path.join(this.dir, '.shared')
  }

  shared(name: string): string {
    return inside(this.sharedDir(), name)
  }

  /** The bots file as in git (before the admin's edits). */
  baseBots(): Array<Record<string, unknown> & { name: string }> {
    const bots = readJson<Array<Record<string, unknown> & { name: string }>>(this.botsPath())
    return Array.isArray(bots) ? bots : []
  }

  editsPath(): string {
    const own = this.env().get('BOTS_EDITS')
    return own ? inside(this.dir, own) : this.shared('bots.edits.json')
  }

  edits(): BotEdits {
    try {
      return readBotEdits(this.editsPath())
    } catch {
      return {}
    }
  }

  /** The court's bots as they will start: the bots file with the admin's edits. */
  bots(): Array<Record<string, unknown> & { name: string }> {
    return applyBotEdits(this.baseBots(), this.edits())
  }

  /** Castle designs the works can start: the checkout's own and the overlord's. */
  designs(): string[] {
    const list = (rel: string) => {
      try {
        return fs
          .readdirSync(path.join(this.dir, rel))
          .filter((f) => f.endsWith('.json'))
          .map((f) => `${rel}/${f}`)
      } catch {
        return []
      }
    }
    return [...list('config/castles'), ...list('.state/designs')]
  }

  /** The spells Merlin knows in this world: the built-in ones and those the King taught. */
  learnedSpells(): string[] {
    const magic = readJson<{ learned?: Array<{ id: string }> }>(this.state('magic-merlin.json'))
    return (magic?.learned ?? []).map((s) => s.id)
  }

  // ---- The running court ---------------------------------------------------------------------

  /** The minds this world runs (compose services court and army). */
  divisions(): Division[] {
    const compose = (() => {
      try {
        return fs.readFileSync(path.join(this.dir, 'compose.yaml'), 'utf8')
      } catch {
        return ''
      }
    })()
    return /^\s{2}army:/m.test(compose) ? ['household', 'army'] : ['household']
  }

  /** Each mind's last status (see src/status.ts), marked stale when it stopped writing. */
  status(): Array<CourtStatus & { stale: boolean }> {
    const out: Array<CourtStatus & { stale: boolean }> = []
    for (const name of ['household', 'army', 'all']) {
      const s = readJson<CourtStatus>(this.state(`status-${name}.json`))
      if (s) out.push({ ...s, stale: Date.now() - s.at > STALE_MS })
    }
    return out
  }

  commandPath(division: Division): string {
    return this.state(division === 'army' ? '.command-army' : '.command')
  }

  /** Drop a command line where the court (that mind) picks it up within a second. */
  command(line: string, division: Division): void {
    appendLine(this.commandPath(division), line)
  }

  logDir(division: Division): string {
    return this.state(division === 'army' ? 'logs/army' : 'logs')
  }

  /** The days with a log, newest first ("2026-11-01"). */
  logDays(division: Division): string[] {
    try {
      return fs
        .readdirSync(this.logDir(division))
        .map((f) => /^court-(\d{4}-\d{2}-\d{2})\.log$/.exec(f)?.[1])
        .filter((d): d is string => Boolean(d))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  logPath(division: Division, day: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`)
    return inside(this.logDir(division), `court-${day}.log`)
  }

  /** The containers compose runs for this world. */
  async containers(): Promise<Container[]> {
    const res = await run('docker', ['compose', 'ps', '-a', '--format', 'json'], {
      cwd: this.dir,
      timeoutMs: 15_000,
    })
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'docker compose ps failed')
    const text = res.stdout.trim()
    if (!text) return []
    const rows: Array<Record<string, string>> = text.startsWith('[')
      ? (JSON.parse(text) as Array<Record<string, string>>)
      : text.split('\n').map((l) => JSON.parse(l) as Record<string, string>)
    return rows.map((r) => ({
      name: r.Name,
      service: r.Service,
      state: r.State,
      status: r.Status,
      image: r.Image,
    }))
  }

  /** The checkout's commit and whether it has changes of its own. */
  async version(): Promise<{ commit: string; subject: string; date: string; dirty: string[] }> {
    const log = await run('git', ['-C', this.dir, 'log', '-1', '--format=%h%x09%s%x09%cI'])
    const status = await run('git', ['-C', this.dir, 'status', '--porcelain'])
    const [commit, subject, date] = log.stdout.trim().split('\t')
    return {
      commit: commit ?? '',
      subject: subject ?? '',
      date: date ?? '',
      dirty: status.stdout.split('\n').filter(Boolean),
    }
  }
}
