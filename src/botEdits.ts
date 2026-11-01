import fs from 'node:fs'

/**
 * The admin's changes to the court's bots (src/admin), kept apart from the bots file in git
 * (config/bots.json): per bot name, what differs from that file (merged into it key by key, a
 * null value taking a key away), null for a bot left out of the court, or a whole bot for one
 * the file does not have. A deploy brings the file's own changes; these stay on top of them.
 */
export type BotEdits = Record<string, Record<string, unknown> | null>

type Bot = Record<string, unknown> & { name?: string }

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `edit` merged into `base`: objects key by key, a null taking the key away. */
function merged(base: unknown, edit: unknown): unknown {
  if (!isPlain(base) || !isPlain(edit)) return edit
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(edit)) {
    if (value === null) delete out[key]
    else out[key] = merged(base[key], value)
  }
  return out
}

/** What `wanted` changes in `base`, as an edit for `merged`; undefined when nothing. */
function difference(base: unknown, wanted: unknown): unknown {
  if (equal(base, wanted)) return undefined
  if (!isPlain(base) || !isPlain(wanted)) return wanted
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(wanted)])) {
    if (!(key in wanted)) out[key] = null
    else {
      const d = difference(base[key], wanted[key])
      if (d !== undefined) out[key] = d
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** The bots of the file with the admin's edits: in the file's order, new bots after them. */
export function applyBotEdits<T extends Bot>(bots: T[], edits: BotEdits): T[] {
  const known = new Set(bots.map((b) => b.name))
  const out: T[] = []
  for (const bot of bots) {
    const edit = bot.name !== undefined ? edits[bot.name] : undefined
    if (edit === null) continue
    out.push(edit ? (merged(bot, { ...edit, name: bot.name }) as T) : bot)
  }
  for (const [name, edit] of Object.entries(edits))
    if (!known.has(name) && edit) out.push({ ...edit, name } as T)
  return out
}

/** The edits that turn the file's bots into `wanted` (the court as the admin wants it). */
export function botEdits(bots: Bot[], wanted: Bot[]): BotEdits {
  const edits: BotEdits = {}
  const byName = new Map(wanted.map((b) => [b.name, b]))
  for (const bot of bots) {
    if (bot.name === undefined) continue
    const want = byName.get(bot.name)
    if (!want) edits[bot.name] = null
    else {
      const d = difference(bot, want)
      if (d !== undefined) edits[bot.name] = d as Record<string, unknown>
    }
  }
  const known = new Set(bots.map((b) => b.name))
  for (const want of wanted)
    if (want.name !== undefined && !known.has(want.name)) edits[want.name] = { ...want }
  return edits
}

/** The edits file, or none when it is missing. A broken file is an error: the court says so. */
export function readBotEdits(file: string): BotEdits {
  if (!fs.existsSync(file)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isPlain(parsed)) throw new Error(`${file} must hold an object of bot edits by name`)
  for (const [name, edit] of Object.entries(parsed))
    if (edit !== null && !isPlain(edit))
      throw new Error(`${file}: the edit for ${name} must be an object or null`)
  return parsed as BotEdits
}

/** What is wrong with a court of bots, in plain sentences (nothing: it is sound). */
export function botProblems(bots: Array<{ name?: unknown; reportsTo?: unknown }>): string[] {
  const problems: string[] = []
  const names = new Set<string>()
  for (const bot of bots) {
    if (typeof bot.name !== 'string' || !bot.name.trim()) problems.push('Every bot needs a name')
    else if (names.has(bot.name)) problems.push(`Duplicate bot name: ${bot.name}`)
    else if (!/^[A-Za-z0-9_]{1,16}$/.test(bot.name))
      problems.push(`${bot.name}: a player name has 1 to 16 letters, digits or underscores`)
    else names.add(bot.name)
  }
  for (const bot of bots)
    if (
      bot.reportsTo !== undefined &&
      (typeof bot.reportsTo !== 'string' || !names.has(bot.reportsTo) || bot.reportsTo === bot.name)
    )
      problems.push(
        `${String(bot.name)} reports to "${String(bot.reportsTo)}", who is not another bot of the court`
      )
  return problems
}
