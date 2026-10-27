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

/** Minimal leveled console logger. Every line is prefixed with a timestamp and the logger name. */
export function createLogger(name: string): Logger {
  const emit = (level: LogLevel, message: string, args: unknown[]) => {
    if (LEVELS[level] < LEVELS[globalLevel]) return
    const ts = new Date().toISOString().slice(11, 23)
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${name}] ${message}`
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(line, ...args)
  }
  return {
    debug: (m, ...a) => emit('debug', m, a),
    info: (m, ...a) => emit('info', m, a),
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
    child: (sub) => createLogger(`${name}:${sub}`),
  }
}
