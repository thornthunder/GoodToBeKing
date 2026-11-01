/**
 * A .env file read and written line by line, so its comments, order and hand edits survive the
 * admin's changes. Values are written so that both dotenv (the court) and docker compose
 * (env_file) read them back the same: plain when they can be, quoted otherwise.
 */
export interface EnvLine {
  /** The line as it stands in the file. */
  raw: string
  key?: string
  value?: string
}

const ENTRY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) {
    const inner = v.slice(1, -1)
    return v[0] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner
  }
  // An unquoted value ends where a comment begins.
  const hash = v.search(/\s#/)
  return (hash >= 0 ? v.slice(0, hash) : v).trim()
}

/** A value as written in the file: plain when it reads back the same, quoted otherwise. */
export function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('a setting must be one line')
  if (value === '' || /^[^\s#'"`$\\]+(?:[^#'"`$\\]*[^\s#'"`$\\])?$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/(["\\])/g, '\\$1')}"`
}

export class EnvFile {
  readonly lines: EnvLine[]

  constructor(text = '') {
    const body = text.replace(/\r\n/g, '\n').replace(/\n$/, '')
    this.lines = (body === '' ? [] : body.split('\n')).map((raw) => {
      const m = ENTRY.exec(raw)
      return m && !raw.trimStart().startsWith('#')
        ? { raw, key: m[1], value: unquote(m[2]) }
        : { raw }
    })
  }

  /** Every key and its value (the last one, when a key is set twice). */
  entries(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const l of this.lines) if (l.key !== undefined) out[l.key] = l.value ?? ''
    return out
  }

  get(key: string): string | undefined {
    return this.entries()[key]
  }

  /** Set a key where it stands (every line of it), or add it at the end; undefined takes it out. */
  set(key: string, value: string | undefined): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not a setting name: ${key}`)
    const at = this.lines.map((l, i) => (l.key === key ? i : -1)).filter((i) => i >= 0)
    if (value === undefined) {
      for (const i of at.reverse()) this.lines.splice(i, 1)
      return
    }
    const line = { raw: `${key}=${quote(value)}`, key, value }
    if (at.length) for (const i of at) this.lines[i] = { ...line }
    else this.lines.push(line)
  }

  toString(): string {
    return this.lines.map((l) => l.raw).join('\n') + '\n'
  }
}
