import type { Point } from '../build/site'
import { total, type WarEvent, type WarState } from './War'

/**
 * The referee's rules of the war game, pure: the arena (two identical halls), the server
 * commands that make it ready for a round, and the score. src/war/main.ts runs the season.
 */
export interface Base {
  /** The middle of the hall's floor (the first air block above the floor). */
  home: Point
}

export interface Arena {
  /** One Minecraft day, in real time (20 minutes). */
  cycleMs: number
  /** Days of peace before the raid, days the raid may last. */
  buildCycles: number
  raidCycles: number
  /** Rounds in a series (then the lessons are drawn and the next series begins), series to play. */
  rounds: number
  series: number
  bases: Record<string, Base>
  /** The bots of each side, by name. */
  sides: Record<string, string[]>
  /**
   * The arena is in a world others play in (the family's Dev world, the King's wish, 2026-11-02:
   * so he can come and watch): the referee touches only the two bases, never the time, the
   * weather or what lies about.
   */
  shared?: boolean
}

/** The hall: this many blocks from the home to each wall; walls this high; the chest's place. */
export const HALL_HALF = 4
export const HALL_HEIGHT = 3
/** Cleared above the floor, so last round's roof goes. */
const CLEAR_ABOVE = 10
/** The floor is made good this deep below. */
const FLOOR_DEPTH = 3

/** Where a base's chest stands: inside, by the north wall. */
export function chestOf(base: Base): Point {
  return { x: base.home.x, y: base.home.y, z: base.home.z - (HALL_HALF - 1) }
}

/** The way in: the middle of the south wall, two high. */
export function doorwayOf(base: Base): Point {
  return { x: base.home.x, y: base.home.y, z: base.home.z + HALL_HALF }
}

/**
 * Server commands that make a base: flat ground, a cobblestone hall three high with a doorway
 * south, nothing inside (last round's roof, beds and furniture go), and an empty chest.
 */
export function hallCommands(base: Base): string[] {
  const { x, y, z } = base.home
  const [x1, x2, z1, z2] = [x - HALL_HALF, x + HALL_HALF, z - HALL_HALF, z + HALL_HALF]
  const top = y + HALL_HEIGHT - 1
  const chest = chestOf(base)
  const door = doorwayOf(base)
  return [
    // The ground: dirt with grass on top, and air above (a roof, trees, a hill).
    `fill ${x1 - 1} ${y - FLOOR_DEPTH} ${z1 - 1} ${x2 + 1} ${y - 2} ${z2 + 1} dirt`,
    `fill ${x1 - 1} ${y - 1} ${z1 - 1} ${x2 + 1} ${y - 1} ${z2 + 1} grass_block`,
    `fill ${x1 - 1} ${y} ${z1 - 1} ${x2 + 1} ${y + CLEAR_ABOVE} ${z2 + 1} air`,
    // Four walls.
    `fill ${x1} ${y} ${z1} ${x2} ${top} ${z1} cobblestone`,
    `fill ${x1} ${y} ${z2} ${x2} ${top} ${z2} cobblestone`,
    `fill ${x1} ${y} ${z1} ${x1} ${top} ${z2} cobblestone`,
    `fill ${x2} ${y} ${z1} ${x2} ${top} ${z2} cobblestone`,
    `fill ${door.x} ${door.y} ${door.z} ${door.x} ${door.y + 1} ${door.z} air`,
    // An empty chest (setblock to air takes what was in it without dropping it).
    `setblock ${chest.x} ${chest.y} ${chest.z} air`,
    `setblock ${chest.x} ${chest.y} ${chest.z} chest`,
  ]
}

/** Every bot of a side home, with empty pockets, waking there after dying. */
export function musterCommands(base: Base, names: string[]): string[] {
  const { x, y, z } = base.home
  return names.flatMap((n) => [
    `clear ${n}`,
    `tp ${n} ${x} ${y} ${z}`,
    `spawnpoint ${n} ${x} ${y} ${z}`,
  ])
}

/**
 * The round's start: both bases made and both sides mustered; in the war's own world also
 * morning, fair weather and nothing lying about.
 */
export function prepareCommands(arena: Arena): string[] {
  const out = arena.shared
    ? []
    : ['time set 1000', 'weather clear', 'gamerule showcoordinates true']
  for (const [side, base] of Object.entries(arena.bases)) {
    out.push(...musterCommands(base, arena.sides[side] ?? []))
    out.push(...hallCommands(base))
  }
  if (!arena.shared) out.push('kill @e[type=item]')
  return out
}

export interface SideScore {
  side: string
  /** Items from the other side's chest put in its own. */
  brought: number
  /** Taken and lost on the way. */
  lost: number
  /** Its own goods put back after they fell by its chest. */
  recovered: number
  kills: number
  deaths: number
  /** Trips that brought something home. */
  trips: number
  /** Minutes from the order to the first grab and the first deposit (undefined: never). */
  firstGrabMin?: number
  firstDepositMin?: number
  plan?: string
}

export interface Score {
  winner?: string
  /** "items", "kills" or "tie". */
  decidedBy: string
  sides: SideScore[]
  why: string
}

export interface Death {
  at: number
  victim: string
  killer?: string
  key: string
}

/** The deaths both sides heard, each once. */
export function mergeDeaths(states: WarState[]): Death[] {
  const out: Death[] = []
  for (const s of states)
    for (const e of s.events) {
      if (e.kind !== 'death' || !e.who) continue
      const echo = out.some(
        (d) => d.victim === e.who && d.key === e.text && Math.abs(d.at - e.at) < 5_000
      )
      if (!echo) out.push({ at: e.at, victim: e.who, killer: e.by, key: e.text ?? '' })
    }
  return out.sort((a, b) => a.at - b.at)
}

/** The score of a round from both sides' accounts. */
export function score(states: WarState[], sides: Record<string, string[]>): Score {
  const deaths = mergeDeaths(states)
  const lower = (names: string[]) => new Set(names.map((n) => n.toLowerCase()))
  const scores: SideScore[] = states.map((s) => {
    const mine = lower(sides[s.side] ?? [])
    const others = new Set(
      Object.entries(sides)
        .filter(([side]) => side !== s.side)
        .flatMap(([, names]) => [...lower(names)])
    )
    const t0 = s.orderedAt ?? s.events[0]?.at ?? 0
    const minutes = (kind: WarEvent['kind']) => {
      const e = s.events.find((x) => x.kind === kind && x.at >= t0)
      return e ? Math.round(((e.at - t0) / 60_000) * 10) / 10 : undefined
    }
    const plan = s.plan
    return {
      side: s.side,
      brought: total(s.brought),
      lost: total(s.lost),
      recovered: total(s.recovered),
      kills: deaths.filter(
        (d) => d.killer && mine.has(d.killer.toLowerCase()) && others.has(d.victim.toLowerCase())
      ).length,
      deaths: deaths.filter((d) => mine.has(d.victim.toLowerCase()) && d.at >= t0).length,
      trips: s.events.filter((e) => e.kind === 'deposit' && total(e.items ?? {}) > 0).length,
      firstGrabMin: minutes('grab'),
      firstDepositMin: minutes('deposit'),
      plan: plan
        ? `${plan.tactic}, ${plan.when}, ${plan.trips} trip(s); ${plan.raiders.length} raiders, ${plan.defenders.length} defenders`
        : undefined,
    }
  })
  const ranked = [...scores].sort((a, b) => b.brought - a.brought || b.kills - a.kills)
  const [first, second] = ranked
  if (!first || !second) return { decidedBy: 'tie', sides: scores, why: 'no sides' }
  if (first.brought !== second.brought)
    return {
      winner: first.side,
      decidedBy: 'items',
      sides: scores,
      why: `${first.side} brought ${first.brought} items home to ${second.side}'s ${second.brought}`,
    }
  if (first.kills !== second.kills)
    return {
      winner: first.side,
      decidedBy: 'kills',
      sides: scores,
      why: `both brought ${first.brought} items home; ${first.side} killed ${first.kills} to ${second.side}'s ${second.kills}`,
    }
  return {
    decidedBy: 'tie',
    sides: scores,
    why: `both brought ${first.brought} items home and killed ${first.kills}`,
  }
}

/** A side's result in a round, as its playbook records it. */
export function resultOf(s: Score, side: string): 'won' | 'lost' | 'tie' {
  if (!s.winner) return 'tie'
  return s.winner === side ? 'won' : 'lost'
}

/** The round's events as a side saw them, a line each, for the lessons. */
export function timeline(state: WarState, limit = 80): string[] {
  const t0 = state.orderedAt ?? state.events[0]?.at ?? 0
  const items = (e: WarEvent) =>
    e.items
      ? Object.entries(e.items)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([n, k]) => `${k} ${n}`)
          .join(', ')
      : ''
  const lines = state.events
    .filter((e) => e.at >= t0)
    .map((e) => {
      const min = Math.round(((e.at - t0) / 60_000) * 10) / 10
      const what: Record<WarEvent['kind'], string> = {
        reset: 'the round began',
        order: `the order came: ${e.text ?? ''}`,
        plan: `the plan: ${e.text ?? ''}`,
        start: 'the raiders set out',
        grab: `${e.who} took from their chest: ${items(e)}`,
        deposit: `${e.who} put loot in our chest: ${items(e)}`,
        lost: `${e.who} lost what it carried: ${items(e)}`,
        recovered: `${e.who} put our goods back: ${items(e)}`,
        death: `${e.who} died${e.by ? `, killed by ${e.by}` : ''} (${(e.text ?? '').replace(/^death\./, '')})`,
        done: `${e.who} stopped: ${e.text ?? ''}`,
        end: 'the raid ended',
        note: e.text ?? '',
      }
      return `${min} min: ${what[e.kind]}`
    })
  return lines.length > limit
    ? [...lines.slice(0, limit - 1), `... and ${lines.length - limit + 1} more`]
    : lines
}
