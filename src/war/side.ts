import fs from 'node:fs'
import path from 'node:path'

/**
 * Which side of the war game this process is (COURT_SIDE: "blue", "green" or "white"), and who
 * the others are. Each other side's bots are read from its bots file (config/war/<side>.json):
 * the side never talks to any of them, and fights them when at war. Which of them it plays in a
 * round the referee says with its order (season 2, the King's wish, 2026-11-04: White joined
 * as an expansion side, and two sides play each round, a round robin).
 */
export interface Side {
  name: string
  /** The other sides' bots, by side. */
  others: Record<string, string[]>
  /** Every other side's bots, together. */
  enemies: string[]
}

export const SIDES = ['blue', 'green', 'white']

export function warSide(env: NodeJS.ProcessEnv = process.env): Side | undefined {
  const name = env.COURT_SIDE?.trim().toLowerCase()
  if (!name) return undefined
  if (!SIDES.includes(name))
    throw new Error(`COURT_SIDE must be one of ${SIDES.join(', ')}, got "${name}"`)
  const others: Record<string, string[]> = {}
  for (const other of SIDES.filter((s) => s !== name)) {
    const file = path.resolve(`config/war/${other}.json`)
    const names = botNames(file)
    if (!names.length) throw new Error(`${file}: no bots of the ${other} side to be found`)
    others[other] = names
  }
  return { name, others, enemies: Object.values(others).flat() }
}

/**
 * The side an order names (`vs <side>`), or with none given the only other side there is;
 * undefined when that is no side of ours to fight.
 */
export function opponent(
  side: Side,
  named?: string
): { name: string; names: string[] } | undefined {
  const key = named?.trim().toLowerCase()
  if (key) return side.others[key] ? { name: key, names: side.others[key] } : undefined
  const all = Object.keys(side.others)
  return all.length === 1 ? { name: all[0], names: side.others[all[0]] } : undefined
}

/** The bot names of a bots file. */
export function botNames(file: string): string[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((b: unknown) => (typeof b === 'object' && b ? (b as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

/** "Blue" */
export function sideTitle(side: string): string {
  return side.charAt(0).toUpperCase() + side.slice(1)
}
