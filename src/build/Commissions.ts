import fs from 'node:fs'
import path from 'node:path'
import type { BuildOutcome } from '../ai/Brain'
import type { BlueprintId, Palette } from './blueprints'
import type { Point } from './site'

export type CommissionStatus = 'waiting' | 'building' | 'done' | 'failed'

/** A royal's wish for one of the small builds, and who is seeing to it. */
export interface Commission {
  id: string
  blueprint: BlueprintId
  /** "a flower garden" */
  title: string
  palette: Palette
  /** The royal who asked (player name). */
  requestedBy: string
  /** The courtier who took the request: the builder asked, or the Castellan who hands it on. */
  takenBy: string
  /** The one who took it builds it too. */
  own: boolean
  /** Where the royal stood when asking: it goes up close by. Unknown until a bot sees them. */
  near?: Point
  status: CommissionStatus
  /** The builder on it, or the one who built it. */
  worker?: string
  /** Why it could not be built, in plain words. */
  reason?: string
  attempts: number
  at: number
  doneAt?: number
}

/** Tries before a build that keeps coming out incomplete is given up. */
export const MAX_COMMISSION_ATTEMPTS = 3
/** Finished commissions stay in the prompts this long, then are forgotten. */
const KEEP_MS = 3 * 24 * 3_600_000

const REASONS: Partial<Record<NonNullable<BuildOutcome['reason']>, string>> = {
  no_site: 'there is no clear, flat ground there',
  unreachable: 'the builder could not get there',
  stuck: 'too many blocks would not hold',
}

/**
 * The builds the royal family asked for, from the request to the last block. The Castellan
 * takes a request and hands it to a free builder of his staff; a builder asked directly builds
 * it himself. File-backed, so a request is never lost to a restart, and every courtier who took
 * or built one can say truthfully how it stands.
 */
export class CommissionBook {
  private list: Commission[] = []
  private next = 1

  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        next?: number
        commissions?: Commission[]
      }
      this.list = saved.commissions ?? []
      this.next = saved.next ?? this.list.length + 1
      // A build cut short by a restart starts again.
      for (const c of this.list) if (c.status === 'building') c.status = 'waiting'
    } catch {
      // Unreadable: start with an empty book.
    }
  }

  add(c: Omit<Commission, 'id' | 'status' | 'attempts' | 'at'>, now = Date.now()): Commission {
    const commission: Commission = {
      ...c,
      id: `C${this.next++}`,
      status: 'waiting',
      attempts: 0,
      at: now,
    }
    this.list.push(commission)
    this.save(now)
    return commission
  }

  find(id: string): Commission | undefined {
    return this.list.find((c) => c.id === id)
  }

  /** Waiting for a builder, oldest first. */
  waiting(): Commission[] {
    return this.list.filter((c) => c.status === 'waiting')
  }

  /** Where the royal was seen, once a bot sees them. */
  locate(id: string, near: Point): void {
    const c = this.find(id)
    if (!c) return
    c.near = { x: Math.floor(near.x), y: Math.floor(near.y), z: Math.floor(near.z) }
    this.save()
  }

  start(id: string, worker: string): void {
    const c = this.find(id)
    if (!c) return
    c.status = 'building'
    c.worker = worker
    this.save()
  }

  /**
   * How the build went. Cut short (a royal called the builder away): it waits for a builder
   * again. Incomplete: tried again, up to MAX_COMMISSION_ATTEMPTS. No place to build: failed.
   */
  finish(id: string, outcome: Pick<BuildOutcome, 'ok' | 'reason'>, now = Date.now()): void {
    const c = this.find(id)
    if (!c) return
    if (outcome.ok) {
      c.status = 'done'
      c.doneAt = now
      c.reason = undefined
    } else if (outcome.reason === 'cancelled' || outcome.reason === 'busy') {
      c.status = 'waiting'
      if (!c.own) c.worker = undefined
    } else if (outcome.reason === 'not_visible') {
      // The builder could not see where the royal stood: it waits until someone sees them.
      c.status = 'waiting'
      c.near = undefined
    } else {
      c.attempts++
      const retry =
        (outcome.reason === 'stuck' || outcome.reason === 'unreachable') &&
        c.attempts < MAX_COMMISSION_ATTEMPTS
      c.status = retry ? 'waiting' : 'failed'
      if (!c.own && retry) c.worker = undefined
      c.reason = REASONS[outcome.reason ?? 'stuck'] ?? 'the building went wrong'
      if (!retry) c.doneAt = now
    }
    this.save(now)
  }

  /** The commissions a courtier took or builds: open ones and those finished lately, oldest first. */
  of(bot: string, now = Date.now()): Commission[] {
    const me = bot.toLowerCase()
    return this.list.filter(
      (c) =>
        (c.takenBy.toLowerCase() === me || c.worker?.toLowerCase() === me) &&
        (c.doneAt === undefined || now - c.doneAt < KEEP_MS)
    )
  }

  all(): readonly Commission[] {
    return this.list
  }

  private save(now = Date.now()): void {
    // Long finished ones are forgotten.
    this.list = this.list.filter((c) => c.doneAt === undefined || now - c.doneAt < KEEP_MS)
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(
      this.file,
      JSON.stringify({ next: this.next, commissions: this.list }, null, 2)
    )
  }
}

/** One commission for a courtier's prompt: "a flower garden for the Princess: George is building it now". */
export function describeCommission(
  c: Commission,
  me: string,
  label: (player: string) => string,
  now = Date.now()
): string {
  const who = label(c.requestedBy)
  const by = (name: string | undefined) =>
    name?.toLowerCase() === me.toLowerCase() ? 'you' : (name ?? 'a builder')
  const head = `${c.title} for ${who}`
  switch (c.status) {
    case 'waiting':
      if (!c.near)
        return `${head}: not started; it waits until ${who} is in sight, to know where it goes`
      if (c.own) return `${head}: not started; you build it as soon as you are free`
      return `${head}: not started; it waits for ${c.worker ? by(c.worker) : 'a free builder'}`
    case 'building':
      return `${head}: ${by(c.worker) === 'you' ? 'you are' : `${c.worker} is`} building it right now`
    case 'done':
      return `${head}: finished by ${by(c.worker)} ${ago(now - (c.doneAt ?? now))}`
    case 'failed':
      return `${head}: could not be built (${c.reason ?? 'it went wrong'})`
  }
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 90) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`
}
