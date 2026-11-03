import fs from 'node:fs'
import path from 'node:path'
import type { Point } from '../build/site'

/**
 * One side's account of the war game (the King's experiment, 2026-11-02): two courts, Blue and
 * Green, live their survival lives for some days, then each is ordered to raid the other's chest.
 * What a side brings back and puts in its own chest wins; kills decide a tie. This is the side's
 * own view, kept in `.state/war.json`: the referee (src/war/main.ts) reads both sides' files to
 * keep score, and the side's captain reads its playbook (the lessons of past rounds) to plan.
 */
export type Phase = 'peace' | 'raid' | 'ended'

/** How the raiders go about the enemy's chest. */
export type Tactic = 'rush' | 'fight' | 'wait'
export const TACTICS: Tactic[] = ['rush', 'fight', 'wait']
/** When the raid sets out. */
export type When = 'now' | 'day' | 'night'
export const WHENS: When[] = ['now', 'day', 'night']

export interface Plan {
  raiders: string[]
  defenders: string[]
  tactic: Tactic
  when: When
  /** How many times each raider goes over (until the chest is found empty). */
  trips: number
  /** The captain's line to the side. */
  words?: string
  reason?: string
  by: 'model' | 'default'
}

export interface Enemy {
  side: string
  names: string[]
  chest: Point
  home: Point
}

export type EventKind =
  | 'reset'
  | 'order'
  | 'plan'
  | 'start'
  | 'grab'
  | 'deposit'
  | 'lost'
  | 'recovered'
  | 'death'
  | 'done'
  | 'end'
  | 'note'

export interface WarEvent {
  at: number
  kind: EventKind
  /** The courtier it concerns (for a death: the victim). */
  who?: string
  /** For a death: the killer. */
  by?: string
  items?: Record<string, number>
  text?: string
}

export interface RaiderProgress {
  trips: number
  /** Taken from the enemy's chest and not yet in ours. */
  carrying: Record<string, number>
  /** Why it stopped, once it has. */
  done?: string
}

/** A courtier as it stood when the order came: its gear in words, its health and food. */
export interface Muster {
  name: string
  role: string
  gear: string
  health?: number
  food?: number
}

export interface WarState {
  side: string
  series?: number
  round?: number
  phase: Phase
  enemy?: Enemy
  orderedAt?: number
  plan?: Plan
  /** The side as it stood when the order came (the lessons see both sides' musters). */
  muster?: Muster[]
  /** What the round is won by (src/war/referee.ts): the raid's loot, or metal in our chest. */
  objective?: 'raid' | 'metals'
  /** Our chest as counted at the referee's word (a metals round). */
  counted?: { items: Record<string, number>; at: number }
  /** A metals round: the captain's councils held so far. */
  councils?: number
  startedAt?: number
  endedAt?: number
  raiders: Record<string, RaiderProgress>
  /** Loot from the enemy's chest now in ours, by item. */
  brought: Record<string, number>
  /** Loot taken and lost on the way (the raider died). */
  lost: Record<string, number>
  /** Our goods picked up off the ground near our chest and put back. */
  recovered: Record<string, number>
  /** Enemies our side killed, and our own dead, since the order. */
  kills: number
  deaths: number
  /** Every raider has stopped (its trips done, the chest found empty, or dead for good). */
  done: boolean
  events: WarEvent[]
}

const MAX_EVENTS = 3_000
/** The same death heard by every bot of the side counts once. */
const DEATH_ECHO_MS = 5_000

export function add(into: Record<string, number>, items: Record<string, number>): void {
  for (const [name, n] of Object.entries(items)) if (n > 0) into[name] = (into[name] ?? 0) + n
}

export function total(items: Record<string, number>): number {
  return Object.values(items).reduce((n, k) => n + k, 0)
}

/** The side's war state, file-backed: every change is written at once. */
export class WarBook {
  private state: WarState

  constructor(
    private readonly file: string | undefined,
    readonly side: string
  ) {
    this.state = this.load() ?? fresh(side)
  }

  private load(): WarState | undefined {
    if (!this.file || !fs.existsSync(this.file)) return undefined
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<WarState>
      return { ...fresh(this.side), ...raw, side: this.side }
    } catch {
      return undefined
    }
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    fs.renameSync(tmp, this.file)
  }

  get data(): Readonly<WarState> {
    return this.state
  }

  get phase(): Phase {
    return this.state.phase
  }

  get enemy(): Enemy | undefined {
    return this.state.enemy
  }

  get plan(): Plan | undefined {
    return this.state.plan
  }

  private note(event: Omit<WarEvent, 'at'>, now = Date.now()): void {
    this.state.events.push({ at: now, ...event })
    if (this.state.events.length > MAX_EVENTS)
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS)
  }

  /** A new round: peace, and nothing counted. */
  reset(series: number | undefined, round: number | undefined, now = Date.now()): void {
    this.state = { ...fresh(this.side), series, round }
    this.note({ kind: 'reset', text: `round ${round ?? '?'} of series ${series ?? '?'}` }, now)
    this.save()
  }

  /**
   * The referee's order: raid the enemy's chest (a raid round), or from now on anything goes,
   * and the metal in our own chest wins (a metals round: the captain holds a council a day).
   */
  order(enemy: Enemy, now = Date.now(), objective: 'raid' | 'metals' = 'raid'): void {
    this.state.phase = 'raid'
    this.state.objective = objective
    this.state.enemy = enemy
    this.state.orderedAt = now
    this.state.plan = undefined
    this.state.startedAt = undefined
    this.state.endedAt = undefined
    this.state.raiders = {}
    this.state.done = false
    this.note(
      {
        kind: 'order',
        text:
          objective === 'metals'
            ? `anything goes: the most metal in our own chest wins; the ${enemy.side} chest is at ${enemy.chest.x},${enemy.chest.y},${enemy.chest.z}`
            : `raid the ${enemy.side} chest at ${enemy.chest.x},${enemy.chest.y},${enemy.chest.z}`,
      },
      now
    )
    this.save()
  }

  setPlan(plan: Plan, now = Date.now()): void {
    this.state.plan = plan
    for (const name of plan.raiders) this.state.raiders[name] = { trips: 0, carrying: {} }
    this.note(
      {
        kind: 'plan',
        text:
          `${plan.tactic}, ${plan.when}, ${plan.trips} trip(s): raiders ${plan.raiders.join(', ') || 'none'}; ` +
          `defenders ${plan.defenders.join(', ') || 'none'} (${plan.by})` +
          (plan.reason ? `: ${plan.reason}` : ''),
      },
      now
    )
    this.save()
  }

  /**
   * A metals round's council: the day's plan. Raiders out on a raid keep what they carry; the
   * rest are ready to go again (a raider done yesterday may raid today).
   */
  council(plan: Plan, day: number, words: string, now = Date.now()): void {
    this.state.plan = plan
    this.state.councils = (this.state.councils ?? 0) + 1
    for (const name of plan.raiders) {
      const r = this.state.raiders[name]
      this.state.raiders[name] = { trips: r?.trips ?? 0, carrying: r?.carrying ?? {} }
    }
    this.state.done = false
    this.note({ kind: 'plan', text: `day ${day}: ${words}` }, now)
    this.save()
  }

  /** Our chest counted at the referee's word. */
  count(items: Record<string, number>, words: string, now = Date.now()): void {
    this.state.counted = { items, at: now }
    this.note({ kind: 'note', text: `our chest counted: ${words}` }, now)
    this.save()
  }

  /** The side as it stood when the order came. */
  muster(members: Muster[]): void {
    this.state.muster = members
    this.save()
  }

  /** The raiders set out. */
  start(now = Date.now()): void {
    this.state.startedAt = now
    this.note({ kind: 'start' }, now)
    this.save()
  }

  /** A raider took these from the enemy's chest. */
  grab(who: string, items: Record<string, number>, now = Date.now()): void {
    const r = this.raider(who)
    r.trips++
    add(r.carrying, items)
    this.note({ kind: 'grab', who, items }, now)
    this.save()
  }

  /** A raider put these in our chest: what it carried from theirs counts. */
  deposit(who: string, items: Record<string, number>, now = Date.now()): Record<string, number> {
    const r = this.raider(who)
    const loot: Record<string, number> = {}
    for (const [name, n] of Object.entries(items)) {
      const k = Math.min(n, r.carrying[name] ?? 0)
      if (k <= 0) continue
      loot[name] = k
      r.carrying[name] -= k
      if (r.carrying[name] <= 0) delete r.carrying[name]
    }
    add(this.state.brought, loot)
    this.note({ kind: 'deposit', who, items: loot }, now)
    this.save()
    return loot
  }

  /** A raider died (or gave up) with loot in its pockets. */
  lost(who: string, now = Date.now()): Record<string, number> {
    const r = this.raider(who)
    const gone = { ...r.carrying }
    r.carrying = {}
    if (total(gone) > 0) {
      add(this.state.lost, gone)
      this.note({ kind: 'lost', who, items: gone }, now)
      this.save()
    }
    return gone
  }

  /** A defender put things found on the ground near our chest back in. */
  recovered(who: string, items: Record<string, number>, now = Date.now()): void {
    if (total(items) <= 0) return
    add(this.state.recovered, items)
    this.note({ kind: 'recovered', who, items }, now)
    this.save()
  }

  /** A raider has stopped for good. */
  raiderDone(who: string, why: string, now = Date.now()): void {
    const r = this.raider(who)
    if (r.done) return
    r.done = why
    this.note({ kind: 'done', who, text: why }, now)
    const plan = this.state.plan
    if (plan && plan.raiders.every((n) => this.state.raiders[n]?.done)) this.state.done = true
    this.save()
  }

  /**
   * A death notice the side heard: counted when it concerns the two sides (ours or theirs),
   * during the raid, once however many of the side heard it.
   */
  death(victim: string, killer: string | undefined, key: string, now = Date.now()): boolean {
    if (this.state.phase !== 'raid') return false
    const enemy = this.state.enemy
    const ours = (n: string | undefined) => n !== undefined && this.mine.has(n.toLowerCase())
    const theirs = (n: string | undefined) =>
      n !== undefined && (enemy?.names ?? []).some((e) => e.toLowerCase() === n.toLowerCase())
    if (!ours(victim) && !theirs(victim)) return false
    const echo = this.state.events.some(
      (e) => e.kind === 'death' && e.who === victim && e.text === key && now - e.at < DEATH_ECHO_MS
    )
    if (echo) return false
    if (ours(victim)) this.state.deaths++
    if (theirs(victim) && ours(killer)) this.state.kills++
    this.note({ kind: 'death', who: victim, by: killer, text: key }, now)
    this.save()
    return true
  }

  /** The referee ends the raid. */
  end(now = Date.now()): void {
    if (this.state.phase === 'ended') return
    this.state.phase = 'ended'
    this.state.endedAt = now
    this.state.done = true
    this.note({ kind: 'end' }, now)
    this.save()
  }

  remark(text: string, who?: string, now = Date.now()): void {
    this.note({ kind: 'note', who, text }, now)
    this.save()
  }

  /** Our own courtiers (lower case), for telling deaths apart. */
  mine = new Set<string>()

  private raider(who: string): RaiderProgress {
    return (this.state.raiders[who] ??= { trips: 0, carrying: {} })
  }
}

function fresh(side: string): WarState {
  return {
    side,
    phase: 'peace',
    raiders: {},
    brought: {},
    lost: {},
    recovered: {},
    kills: 0,
    deaths: 0,
    done: false,
    events: [],
  }
}

/** The side's war state as another process reads it (the referee). */
export function readWar(file: string): WarState | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WarState
  } catch {
    return undefined
  }
}
