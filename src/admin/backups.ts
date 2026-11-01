import fs from 'node:fs'
import path from 'node:path'
import type { LocalServer } from './bds'
import { since } from './files'
import { run } from './jobs'
import type { World } from './world'

/**
 * Backups into one host folder (ADMIN_BACKUPS): a world's court state (.state without its logs,
 * and the shared folder), or the local server's world, copied while the server holds its saving
 * (save hold / save query / save resume, as Bedrock's own docs say).
 */
export interface Backup {
  name: string
  sizeKb: number
  at: number
}

const NAME = /^[\w.-]+\.tgz$/

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
}

export function listBackups(dir: string): Backup[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => NAME.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        return { name: f, sizeKb: Math.round(st.size / 1024), at: st.mtimeMs }
      })
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

export function backupPath(dir: string, name: string): string {
  if (!NAME.test(name)) throw new Error('not a backup')
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) throw new Error('no such backup')
  return file
}

/** The tar steps for a world's court state. */
export function stateBackupSteps(
  world: World,
  dir: string
): { file: string; steps: Array<{ cmd: string; args: string[] }> } {
  const file = path.join(dir, `${world.id}-state-${stamp()}.tgz`)
  const shared = world.sharedDir()
  const args = ['czf', file, '--exclude=.state/logs', '--exclude=*.tmp', '-C', world.dir, '.state']
  if (fs.existsSync(shared)) args.push('-C', path.dirname(shared), path.basename(shared))
  return { file, steps: [{ cmd: 'tar', args }] }
}

/**
 * The local server's world, copied while it holds its saving. Returns what it wrote, or throws
 * (the saving is resumed whatever happens).
 */
export async function serverBackup(
  server: LocalServer,
  dir: string,
  log: (t: string) => void
): Promise<string> {
  const level = server.properties().find((p) => p.key === 'level-name')?.value
  if (!level || !/^[\w .-]+$/.test(level)) throw new Error('the server has no level-name')
  const worlds = path.join(server.def.dir, 'worlds')
  const staging = fs.mkdtempSync(path.join(dir, '.staging-'))
  const from = server.console().size
  server.send('save hold')
  try {
    log('save hold: waiting for the server to say its files are ready')
    let list: string | undefined
    for (let i = 0; i < 30 && !list; i++) {
      await new Promise((r) => setTimeout(r, 1_000))
      server.send('save query')
      await new Promise((r) => setTimeout(r, 500))
      const out = since(path.join(server.def.dir, 'console.log'), from).text
      const ready = out.lastIndexOf('Files are now ready to be copied')
      if (ready >= 0) list = out.slice(ready).split('\n')[1]
    }
    if (!list) throw new Error('the server did not get its files ready in 45 s')
    // "court-test/db/000005.ldb:1234, court-test/level.dat:2048, ...": each file, cut to length.
    let copied = 0
    for (const part of list.replace(/^\[[^\]]*\]\s*/, '').split(', ')) {
      const m = /^(.+):(\d+)$/.exec(part.trim())
      if (!m) continue
      const rel = path.normalize(m[1])
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      const src = path.join(worlds, rel)
      const dst = path.join(staging, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      const length = Number(m[2])
      const fd = fs.openSync(src, 'r')
      try {
        const buf = Buffer.alloc(length)
        const read = fs.readSync(fd, buf, 0, length, 0)
        fs.writeFileSync(dst, buf.subarray(0, read))
      } finally {
        fs.closeSync(fd)
      }
      copied++
    }
    log(`copied ${copied} files of ${level}`)
  } finally {
    try {
      server.send('save resume')
      log('save resume')
    } catch {
      // The server stopped meanwhile: nothing to resume.
    }
  }
  const file = path.join(dir, `server-${level.replace(/\s+/g, '_')}-${stamp()}.tgz`)
  const res = await run('tar', ['czf', file, '-C', staging, '.'], { timeoutMs: 120_000 })
  fs.rmSync(staging, { recursive: true, force: true })
  if (res.code !== 0) throw new Error(res.stderr || 'tar failed')
  return file
}
