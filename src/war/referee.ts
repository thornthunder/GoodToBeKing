import type { Point } from '../build/site'
import { total, type WarEvent, type WarState } from './War'

/**
 * The referee's rules of the war game, pure: the arena (identical halls, one a side), who plays
 * whom, the server commands that make it ready for a round, and the score. src/war/main.ts runs
 * the season.
 */
export interface Base {
  /** The middle of the hall's floor (the first air block above the floor). */
  home: Point
}

export interface Arena {
  /**
   * The season (season 2, the King's wish, 2026-11-04: White joined as an expansion side with
   * no playbook; a round robin, two sides a round, the third sits it out).
   */
  season: number
  /** One Minecraft day, in real time (20 minutes). */
  cycleMs: number
  /** Days of peace before the raid, days the raid may last. */
  buildCycles: number
  raidCycles: number
  /** Rounds in a series (then the lessons are drawn and the next series begins), series to play. */
  rounds: number
  series: number
  /** Each side's hall, in the order the sides are listed (which sets the fixtures). */
  bases: Record<string, Base>
  /** The bots of each side, by name. */
  sides: Record<string, string[]>
  /**
   * The arena is in a world others play in (the family's Dev world, the King's wish, 2026-11-02:
   * so he can come and watch): the referee touches only the two bases, never the time, the
   * weather or what lies about.
   */
  shared?: boolean
  /**
   * From this series on, a round is won by the metal in one's own chest after the days of peace
   * (the King's rule for series 3, 2026-11-03: "they can mine, they can steal, they can buy,
   * whatever"): points per bar; no raid order, as either side may raid when it likes.
   */
  metals?: { fromSeries: number; points: Record<string, number> }
}

/**
 * The two sides that play round `round` of a series: every pair of sides in turn, a round robin
 * (with three sides: first and second, first and third, second and third, so each side plays
 * two rounds in a row and sits the next out); with two sides, both every round.
 */
export function pairing(sides: string[], round: number): [string, string] {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < sides.length; i++)
    for (let j = i + 1; j < sides.length; j++) pairs.push([sides[i], sides[j]])
  if (!pairs.length) throw new Error(`a round needs two sides, not ${sides.length}`)
  return pairs[(((round - 1) % pairs.length) + pairs.length) % pairs.length]
}

/** What a round is won by: items brought home in the raid, or metal in one's own chest. */
export type Objective = 'raid' | 'metals'

export function objectiveOf(arena: Pick<Arena, 'metals'>, series: number): Objective {
  return arena.metals && series >= arena.metals.fromSeries ? 'metals' : 'raid'
}

/** The bars that score, best first. */
export const METAL_POINTS: Record<string, number> = {
  gold_ingot: 100,
  iron_ingot: 25,
  copper_ingot: 10,
}

/** The points a chest's bars are worth. */
export function metalPoints(
  items: Record<string, number>,
  points: Record<string, number> = METAL_POINTS
): number {
  return Object.entries(points).reduce((n, [bar, p]) => n + (items[bar] ?? 0) * p, 0)
}

/** "2 gold, 6 iron, 11 copper (370 points)". */
export function metalWords(
  items: Record<string, number>,
  points: Record<string, number> = METAL_POINTS
): string {
  const bars = Object.keys(points)
    .filter((bar) => (items[bar] ?? 0) > 0)
    .map((bar) => `${items[bar]} ${bar.replace(/_ingot$/, '')}`)
  return `${bars.length ? bars.join(', ') : 'no bars'} (${metalPoints(items, points)} points)`
}

/** The hall: this many blocks from the home to each wall; walls this high; the chest's place. */
export const HALL_HALF = 4
export const HALL_HEIGHT = 3
/** Cleared above the floor, so last round's roof goes. */
const CLEAR_ABOVE = 10
/** The ground is made good this deep below (a creeper's crater goes four deep). */
const FLOOR_DEPTH = 5
/**
 * Level ground this far beyond the walls too. On 2026-11-02 the craters creepers left at both
 * doorsteps (a drop of four, which the court never takes) sealed both halls for the pathfinder,
 * and the last round's craters outlived the next round's making of the hall.
 */
export const APRON = 4
/** The doorstep, this wide and this long, is stone: creepers leave no crater at the door. */
const STEP_HALF = 2
const STEP_LENGTH = 4

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
  const [ax1, ax2, az1, az2] = [x1 - APRON, x2 + APRON, z1 - APRON, z2 + APRON]
  return [
    // The ground, the apron round the hall included: dirt with grass on top, and air above (a
    // roof, trees, a hill, last round's craters).
    `fill ${ax1} ${y - FLOOR_DEPTH} ${az1} ${ax2} ${y - 2} ${az2} dirt`,
    `fill ${ax1} ${y - 1} ${az1} ${ax2} ${y - 1} ${az2} grass_block`,
    `fill ${ax1} ${y} ${az1} ${ax2} ${y + CLEAR_ABOVE} ${az2} air`,
    // A stone doorstep outside the doorway.
    `fill ${door.x - STEP_HALF} ${y - 1} ${door.z + 1} ${door.x + STEP_HALF} ${y - 1} ${door.z + STEP_LENGTH} stone`,
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
 * The round's start: the playing sides' bases made and those sides mustered (a side sitting the
 * round out is left alone); in the war's own world also morning, fair weather and nothing lying
 * about.
 */
export function prepareCommands(
  arena: Pick<Arena, 'bases' | 'sides' | 'shared'>,
  playing: string[] = Object.keys(arena.bases)
): string[] {
  const out = arena.shared
    ? []
    : ['time set 1000', 'weather clear', 'gamerule showcoordinates true']
  for (const side of playing) {
    const base = arena.bases[side]
    if (!base) continue
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
  /** The metals objective: the points in its chest at the count, and the bars there. */
  points?: number
  metals?: Record<string, number>
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

/**
 * The score of a metals round: the points of the bars in each side's own chest at the count,
 * then kills (the raids' bookkeeping, deaths and trips as in a raid round, for the record).
 */
export function scoreMetals(
  states: WarState[],
  sides: Record<string, string[]>,
  chests: Record<string, Record<string, number>>,
  points: Record<string, number> = METAL_POINTS
): Score {
  const base = score(states, sides)
  const scores: SideScore[] = base.sides.map((s) => {
    const items = chests[s.side] ?? {}
    const metals = Object.fromEntries(
      Object.keys(points)
        .filter((bar) => (items[bar] ?? 0) > 0)
        .map((bar) => [bar, items[bar]])
    )
    return { ...s, points: metalPoints(items, points), metals }
  })
  const ranked = [...scores].sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || b.kills - a.kills)
  const [first, second] = ranked
  if (!first || !second) return { decidedBy: 'tie', sides: scores, why: 'no sides' }
  const has = (s: SideScore) => `${s.side} has ${metalWords(s.metals ?? {}, points)}`
  if (first.points !== second.points)
    return {
      winner: first.side,
      decidedBy: 'metals',
      sides: scores,
      why: `${has(first)} in its chest to ${has(second).replace(/ has /, "'s ")}`,
    }
  if (first.kills !== second.kills)
    return {
      winner: first.side,
      decidedBy: 'kills',
      sides: scores,
      why: `both have ${first.points} points; ${first.side} killed ${first.kills} to ${second.side}'s ${second.kills}`,
    }
  return {
    decidedBy: 'tie',
    sides: scores,
    why: `both have ${first.points} points and killed ${first.kills}`,
  }
}

/** A side's result in a round, as its playbook records it. */
export function resultOf(s: Score, side: string): 'won' | 'lost' | 'tie' {
  if (!s.winner) return 'tie'
  return s.winner === side ? 'won' : 'lost'
}

/** A side's line in the league table: like goals for and against, items and kills. */
export interface Standing {
  side: string
  played: number
  won: number
  lost: number
  tied: number
  /** Items it brought home from the other's chest, and the other brought home from its. */
  itemsFor: number
  itemsAgainst: number
  kills: number
  /** Its courtiers the other side killed, and its deaths of every kind. */
  killed: number
  deaths: number
}

/** The league table of the rounds played: most won first, then the better item difference. */
export function league(results: Array<{ score: Score }>, sides: string[]): Standing[] {
  const table = new Map<string, Standing>(
    sides.map((side) => [
      side,
      {
        side,
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        itemsFor: 0,
        itemsAgainst: 0,
        kills: 0,
        killed: 0,
        deaths: 0,
      },
    ])
  )
  for (const { score: s } of results) {
    for (const me of s.sides) {
      const row = table.get(me.side)
      const other = s.sides.find((x) => x.side !== me.side)
      if (!row || !other) continue
      row.played++
      const result = resultOf(s, me.side)
      if (result === 'won') row.won++
      else if (result === 'lost') row.lost++
      else row.tied++
      row.itemsFor += me.brought
      row.itemsAgainst += other.brought
      row.kills += me.kills
      row.killed += other.kills
      row.deaths += me.deaths
    }
  }
  return [...table.values()].sort(
    (a, b) =>
      b.won - a.won ||
      b.itemsFor - b.itemsAgainst - (a.itemsFor - a.itemsAgainst) ||
      b.kills - a.kills
  )
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
