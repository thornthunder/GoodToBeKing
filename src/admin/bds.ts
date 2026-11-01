import fs from 'node:fs'
import path from 'node:path'
import { since, tail } from './files'

/**
 * The Bedrock server on this machine (the Dev world's), as server/run-bds.sh runs it under
 * systemd: a console fifo (console.in) anyone may write a command to, its output in console.log,
 * and server.properties. Starting and stopping it is systemd's: the admin writes the wish to
 * `.control` and server/bds-control.sh (a root service a systemd path unit starts, see
 * server/install-bds-control.sh) carries it out and answers in `.control-result`.
 */
export interface LocalServerDef {
  /** The server's folder (same path on the host and in the admin's container). */
  dir: string
  /** Its systemd service, e.g. bds-test. */
  service: string
  label?: string
  /** The world whose court plays on it, e.g. "dev". */
  world?: string
}

export interface ControlResult {
  action: string
  code: number
  activeState?: string
  subState?: string
  pid?: number
  since?: string
  at: number
}

export interface Property {
  key: string
  value: string
  help: string
}

const ACTIONS = ['start', 'stop', 'restart', 'status'] as const
export type Action = (typeof ACTIONS)[number]

export class LocalServer {
  constructor(readonly def: LocalServerDef) {}

  private file(name: string): string {
    return path.join(this.def.dir, name)
  }

  exists(): boolean {
    return fs.existsSync(this.file('server.properties'))
  }

  /** The server reads its console: it is running (the fifo has a reader). */
  running(): boolean {
    try {
      const fd = fs.openSync(
        this.file('console.in'),
        fs.constants.O_WRONLY | fs.constants.O_NONBLOCK
      )
      fs.closeSync(fd)
      return true
    } catch {
      return false
    }
  }

  /** Type a command into the server's console (as its operator would). */
  send(command: string): void {
    const line = command.trim().replace(/^\//, '')
    if (!/^[\x20-\x7e]{1,500}$/.test(line))
      throw new Error('one line of plain characters, at most 500')
    let fd: number
    try {
      fd = fs.openSync(this.file('console.in'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    } catch {
      throw new Error('the server is not running (nobody reads its console)')
    }
    try {
      fs.writeSync(fd, line + '\n')
    } finally {
      fs.closeSync(fd)
    }
  }

  /** The console's output: the last part of it, or what came since `from`. */
  console(from?: number): { text: string; size: number } {
    const log = this.file('console.log')
    return from === undefined ? tail(log, 64 * 1024) : since(log, from)
  }

  /** Who is on the server: from the console since it last started. */
  players(): string[] {
    const { text } = tail(this.file('console.log'), 512 * 1024)
    const started = text.lastIndexOf('Server started.')
    const online = new Set<string>()
    for (const m of text
      .slice(Math.max(0, started))
      .matchAll(/Player (connected|disconnected): ([^,]+), xuid/g))
      if (m[1] === 'connected') online.add(m[2])
      else online.delete(m[2])
    return [...online].sort()
  }

  /** The server's version, from its console. */
  version(): string | undefined {
    const { text } = tail(this.file('console.log'), 512 * 1024)
    return [...text.matchAll(/Version:? (\d+\.\d+\.\d+(?:\.\d+)?)/g)].pop()?.[1]
  }

  /** server.properties: each setting, its value and the comment under it. */
  properties(): Property[] {
    const lines = fs.readFileSync(this.file('server.properties'), 'utf8').split(/\r?\n/)
    const out: Property[] = []
    for (const line of lines) {
      const m = /^([a-z0-9-]+)=(.*)$/.exec(line)
      if (m) out.push({ key: m[1], value: m[2], help: '' })
      else if (line.startsWith('#') && out.length)
        out[out.length - 1].help +=
          (out[out.length - 1].help ? ' ' : '') + line.replace(/^#\s?/, '')
    }
    return out
  }

  /** Change settings that are in server.properties (a copy of the file is kept first, once a day). */
  setProperties(changes: Record<string, string>): void {
    const file = this.file('server.properties')
    const text = fs.readFileSync(file, 'utf8')
    const known = new Set(this.properties().map((p) => p.key))
    for (const [key, value] of Object.entries(changes)) {
      if (!known.has(key)) throw new Error(`${key}: not a setting of this server`)
      if (!/^[\x20-\x7e]{0,200}$/.test(value))
        throw new Error(`${key}: one line of plain characters`)
    }
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const backup = `${file}.bak-${day}`
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
    const out = text
      .split('\n')
      .map((line) => {
        const m = /^([a-z0-9-]+)=(.*?)(\r?)$/.exec(line)
        return m && m[1] in changes ? `${m[1]}=${changes[m[1]]}${m[3]}` : line
      })
      .join('\n')
    fs.writeFileSync(file, out)
  }

  /** The last answer of the control service. */
  lastControl(): ControlResult | undefined {
    try {
      return parseControl(fs.readFileSync(this.file('.control-result'), 'utf8'))
    } catch {
      return undefined
    }
  }

  /** Ask systemd to start, stop or restart the server (or just say how it is). */
  async control(action: string, waitMs = 25_000): Promise<ControlResult> {
    if (!ACTIONS.includes(action as Action)) throw new Error(`not an action: ${action}`)
    const asked = Date.now()
    const request = this.file('.control')
    fs.writeFileSync(request, action + '\n')
    while (Date.now() - asked < waitMs) {
      await new Promise((r) => setTimeout(r, 500))
      const result = this.lastControl()
      if (result && result.at >= asked - 1_000 && !fs.existsSync(request)) return result
    }
    if (fs.existsSync(request)) {
      fs.rmSync(request, { force: true })
      throw new Error(
        'nothing answered: the control service is not installed on the host (sudo server/install-bds-control.sh)'
      )
    }
    throw new Error('the control service took too long to answer')
  }
}

/** The control service's answer: key=value lines. */
export function parseControl(text: string): ControlResult {
  const kv: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return {
    action: kv.action ?? '',
    code: Number(kv.code ?? 1),
    ...(kv.ActiveState ? { activeState: kv.ActiveState } : {}),
    ...(kv.SubState ? { subState: kv.SubState } : {}),
    ...(kv.MainPID && kv.MainPID !== '0' ? { pid: Number(kv.MainPID) } : {}),
    ...(kv.ActiveEnterTimestamp ? { since: kv.ActiveEnterTimestamp } : {}),
    at: Number(kv.at ?? 0),
  }
}
