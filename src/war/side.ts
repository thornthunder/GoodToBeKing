import fs from 'node:fs'
import path from 'node:path'

/**
 * Which side of the war game this process is (COURT_SIDE: "blue" or "green"), and who the enemy
 * is. The enemy's bots are read from its bots file (WAR_ENEMY_FILE, by default
 * config/war/<other side>.json): the side never talks to them, and fights them when at war.
 */
export interface Side {
  name: string
  enemy: { name: string; names: string[] }
}

export const SIDES = ['blue', 'green']

export function warSide(env: NodeJS.ProcessEnv = process.env): Side | undefined {
  const name = env.COURT_SIDE?.trim().toLowerCase()
  if (!name) return undefined
  if (!SIDES.includes(name))
    throw new Error(`COURT_SIDE must be ${SIDES.join(' or ')}, got "${name}"`)
  const other = SIDES.find((s) => s !== name)!
  const file = path.resolve(env.WAR_ENEMY_FILE?.trim() || `config/war/${other}.json`)
  const names = botNames(file)
  if (!names.length) throw new Error(`${file}: no enemy bots to be found`)
  return { name, enemy: { name: other, names } }
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
