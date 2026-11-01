import crypto from 'node:crypto'

/**
 * The admin's one password and its sessions. The password is kept only as a scrypt hash
 * ("scrypt$N$salt$hash"); sessions live in memory (a restart signs everyone out).
 */
const N = 16384
const KEY_LENGTH = 32

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N })
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !n || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
  })
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/** A password easy to type from a phone: four groups of five letters and digits. */
export function newPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(20)
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length])
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-')
}

/** A rule for new passwords (undefined: good enough). */
export function weakPassword(password: string): string | undefined {
  if (password.length < 10) return 'at least 10 characters'
  if (/^(.)\1*$/.test(password)) return 'not one character over and over'
  return undefined
}

interface Session {
  created: number
  seen: number
  ip: string
}

/** Signed in this long without a request: signed out. */
const IDLE_MS = 12 * 60 * 60_000
/** And never longer than this. */
const MAX_MS = 7 * 24 * 60 * 60_000

export class Sessions {
  private readonly sessions = new Map<string, Session>()

  open(ip: string, now = Date.now()): string {
    const id = crypto.randomBytes(32).toString('base64url')
    this.sessions.set(id, { created: now, seen: now, ip })
    return id
  }

  /** Whether the session is good, keeping it alive. */
  check(id: string | undefined, now = Date.now()): boolean {
    if (!id) return false
    const s = this.sessions.get(id)
    if (!s) return false
    if (now - s.seen > IDLE_MS || now - s.created > MAX_MS) {
      this.sessions.delete(id)
      return false
    }
    s.seen = now
    return true
  }

  close(id: string | undefined): void {
    if (id) this.sessions.delete(id)
  }

  /** Everyone signed out (after a new password). */
  closeAll(except?: string): void {
    for (const id of this.sessions.keys()) if (id !== except) this.sessions.delete(id)
  }
}

/** Failed sign-ins per address: after five, a wait that doubles with each further failure. */
export class Throttle {
  private readonly fails = new Map<string, { count: number; until: number }>()

  /** How long this address must still wait before trying again (0: it may try). */
  wait(ip: string, now = Date.now()): number {
    const f = this.fails.get(ip)
    return f ? Math.max(0, f.until - now) : 0
  }

  failed(ip: string, now = Date.now()): void {
    const f = this.fails.get(ip) ?? { count: 0, until: 0 }
    f.count++
    if (f.count >= 5) f.until = now + Math.min(60_000 * 2 ** (f.count - 5), 60 * 60_000)
    this.fails.set(ip, f)
  }

  succeeded(ip: string): void {
    this.fails.delete(ip)
  }
}
