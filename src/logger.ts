import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let globalLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  globalLevel = level
}

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVELS
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  child(name: string): Logger
}

const DAY = 24 * 60 * 60_000
let fileSink: { write(line: string): void; close(): Promise<void> } | undefined

/**
 * Also write every line to one file a day in `dir` (court-2026-10-31.log, UTC days), keeping the
 * last `days` of them. A container's own log is thrown away with it on every rebuild, and with
 * it the record of an evening's play.
 */
export function logToFiles(dir: string, days = 7): void {
  fs.mkdirSync(dir, { recursive: true })
  let day = ''
  let stream: fs.WriteStream | undefined
  const prune = () => {
    const cutoff = Date.now() - days * DAY
    for (const f of fs.readdirSync(dir)) {
      const m = /^court-(\d{4}-\d{2}-\d{2})\.log$/.exec(f)
      if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(dir, f), { force: true })
    }
  }
  fileSink = {
    write(line) {
      const today = new Date().toISOString().slice(0, 10)
      if (today !== day) {
        stream?.end()
        day = today
        stream = fs.createWriteStream(path.join(dir, `court-${day}.log`), { flags: 'a' })
        stream.on('error', (err) => {
          console.error(`log file: ${err.message}`)
          fileSink = undefined
        })
        try {
          prune()
        } catch {
          // An old file that will not go is no reason to stop logging.
        }
      }
      stream?.write(line + '\n')
    },
    close: () => new Promise((resolve) => (stream ? stream.end(resolve) : resolve())),
  }
}

/** Flush and close the log file (before the process exits). */
export async function closeLogFiles(): Promise<void> {
  await fileSink?.close()
  fileSink = undefined
}

/** Minimal leveled console logger. Every line is prefixed with a timestamp and the logger name. */
export function createLogger(name: string): Logger {
  const emit = (level: LogLevel, message: string, args: unknown[]) => {
    if (LEVELS[level] < LEVELS[globalLevel]) return
    const ts = new Date().toISOString().slice(11, 23)
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${name}] ${message}`
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(line, ...args)
    fileSink?.write(args.length ? `${line} ${args.map(String).join(' ')}` : line)
  }
  return {
    debug: (m, ...a) => emit('debug', m, a),
    info: (m, ...a) => emit('info', m, a),
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
    child: (sub) => createLogger(`${name}:${sub}`),
  }
}
