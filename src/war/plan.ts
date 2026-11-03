import type { ChatModel } from '../ai/OllamaClient'
import type { Gear } from '../army'
import type { Point } from '../build/site'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { TACTICS, WHENS, type Plan, type Tactic, type When } from './War'

/**
 * The captain's plan for the raid: who goes, who stays, how and when. The model decides from a
 * brief of the side and the lessons of past rounds (the playbook); code carries the plan out.
 * The plan is the one place the side's experience changes what it does, so both sides run the
 * same code and model, and only their playbooks tell them apart.
 */
export interface Member {
  name: string
  role: string
  gear?: Gear
  health?: number
  food?: number
  /** Within reach of home. */
  home: boolean
}

export interface Brief {
  side: string
  captain: string
  enemySide: string
  members: Member[]
  /** What our chest holds. */
  stock: Record<string, number>
  home: Point
  enemyChest: Point
  night: boolean
  /** Lessons from past rounds, newest first. */
  playbook: string[]
  /** How the last rounds went, in a line each. */
  record: string[]
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    raiders: { type: 'array', items: { type: 'string' } },
    defenders: { type: 'array', items: { type: 'string' } },
    tactic: { type: 'string', enum: TACTICS },
    when: { type: 'string', enum: WHENS },
    trips: { type: 'integer', minimum: 1, maximum: 5 },
    words: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['raiders', 'defenders', 'tactic', 'when', 'trips', 'words', 'reason'],
}

const GUIDE = `You are the captain of one side in a war game between two courts of a Minecraft survival server (Normal difficulty, PvP on).
Your side has lived for some days on its own: gathered, mined, farmed, hunted, armed itself. So has the other side, some way off.
Now both sides are ordered at the same moment to raid each other's storehouse chest. There are no rules.
The winner is the side that brings the most items from the other side's chest back and puts them in its own chest.
If that is a tie, the side that killed more of the other side wins.

You decide the plan; your courtiers carry it out exactly:
- raiders: who walks to the enemy chest, takes all they can carry, walks home and puts it in our chest, then goes again (up to "trips" times, or until the enemy chest is found empty).
- defenders: who stays by our chest, fights any enemy who comes within reach, and puts back what they drop.
- tactic (for the raiders): "rush" = straight to the chest, take and run, no fighting unless struck; "fight" = kill the defenders near the chest first, then take; "wait" = stop short of their home, wait for the defenders to leave the chest (up to a few minutes), then go.
- when: "now", "day" (wait for daylight: monsters burn off, everyone sees far), or "night" (monsters about, but their workers are indoors and nobody goes out).
- trips: 1 to 5.
Everyone must be a raider or a defender; name each courtier exactly once. A dead courtier wakes at home, unarmed, after a while, and carries on.
Things to weigh: swords and armour on both sides, health and hunger, how far it is, how much is in our chest worth defending, and above all what the playbook says happened before.
Answer with JSON only: {"raiders": [...], "defenders": [...], "tactic": "...", "when": "...", "trips": n, "words": "one short rousing line to your side, naming who goes and who stays", "reason": "two sentences on why this plan"}.`

/** A courtier's arms in words: its sword, its armour, a shield. */
export function gearWords(m: Member): string {
  const g = m.gear
  if (!g) return 'out of sight'
  const armour = [g.head, g.chest, g.legs, g.feet].filter(Boolean)
  return (
    `${g.sword ? `${g.sword} sword` : 'no sword'}, ` +
    (armour.length ? `${armour.length} piece(s) of ${armour[0]} armour` : 'no armour') +
    (g.shield ? ', a shield' : '')
  )
}

export function briefWords(b: Brief): string {
  const gear = gearWords
  const members = b.members.map(
    (m) =>
      `- ${m.name}${m.name === b.captain ? ' (you, the captain)' : ''}, ${m.role}: ${gear(m)}; ` +
      `health ${m.health ?? '?'}/20, food ${m.food ?? '?'}/20; ${m.home ? 'at home' : 'away from home'}`
  )
  const stock = Object.entries(b.stock)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 12)
    .map(([n, k]) => `${k} ${n}`)
  const items = Object.values(b.stock).reduce((n, k) => n + k, 0)
  const dx = b.enemyChest.x - b.home.x
  const dz = b.enemyChest.z - b.home.z
  const dir = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north'
  return [
    `You are ${b.captain}, captain of the ${b.side} side; the enemy is the ${b.enemySide} side.`,
    `Your side (${b.members.length}):`,
    ...members,
    `Our chest holds ${items} items${stock.length ? `: ${stock.join(', ')}` : ''}.`,
    `The enemy chest is ${Math.round(Math.hypot(dx, dz))} blocks to the ${dir}, at ${b.enemyChest.x},${b.enemyChest.y},${b.enemyChest.z}.`,
    `It is ${b.night ? 'night' : 'day'} now.`,
    b.record.length
      ? `Past rounds:\n${b.record.map((r) => `- ${r}`).join('\n')}`
      : 'This is the first round.',
    b.playbook.length
      ? `Your playbook (lessons from past rounds, newest first):\n${b.playbook.map((l) => `- ${l}`).join('\n')}`
      : 'Your playbook is empty: nothing has been learned yet.',
    'Make the plan.',
  ].join('\n')
}

/**
 * The model's answer as a plan, or undefined when it is not one: names not of the side are
 * dropped, anyone left out defends, nobody both raids and defends.
 */
export function parsePlan(
  raw: unknown,
  names: string[],
  by: Plan['by'] = 'model'
): Plan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  const byName = new Map(names.map((n) => [n.toLowerCase(), n]))
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.map((v) => byName.get(String(v).trim().toLowerCase())).filter(isName))]
      : []
  const raiders = list(p.raiders)
  const defenders = list(p.defenders).filter((n) => !raiders.includes(n))
  for (const n of names) if (!raiders.includes(n) && !defenders.includes(n)) defenders.push(n)
  if (!raiders.length) return undefined
  const tactic = TACTICS.includes(p.tactic as Tactic) ? (p.tactic as Tactic) : 'rush'
  const when = WHENS.includes(p.when as When) ? (p.when as When) : 'now'
  const trips = Math.min(5, Math.max(1, Math.round(Number(p.trips)) || 1))
  const text = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined
  return {
    raiders,
    defenders,
    tactic,
    when,
    trips,
    words: text(p.words),
    reason: text(p.reason),
    by,
  }
}

function isName(n: string | undefined): n is string {
  return n !== undefined
}

/** Without the model: the soldiers raid, the rest hold the chest, straight away. */
export function defaultPlan(names: string[], soldiers: string[]): Plan {
  const raiders = names.filter((n) => soldiers.includes(n))
  const plan = parsePlan(
    {
      raiders: raiders.length ? raiders : names.slice(0, Math.ceil(names.length / 2)),
      defenders: [],
      tactic: 'rush',
      when: 'now',
      trips: 3,
      words: 'To their chest, soldiers! The rest of you, hold the hall!',
      reason: 'The default plan: the soldiers raid, the rest defend.',
    },
    names,
    'default'
  )
  return plan!
}

/** Ask the model for the plan; the default plan when it does not answer or answers nonsense. */
export async function planRaid(
  model: ChatModel,
  brief: Brief,
  soldiers: string[],
  log: Logger,
  opts: { model?: string; timeoutMs?: number } = {}
): Promise<Plan> {
  const names = brief.members.map((m) => m.name)
  const started = Date.now()
  try {
    const response = await model.chat(
      [
        { role: 'system', content: GUIDE },
        { role: 'user', content: briefWords(brief) },
      ],
      {
        model: opts.model,
        shared: Boolean(opts.model),
        format: PLAN_SCHEMA,
        temperature: 0.6,
        think: false,
        timeoutMs: opts.timeoutMs ?? 90_000,
        priority: 'urgent',
      }
    )
    const plan = parsePlan(JSON.parse(response.message.content), names)
    if (plan) {
      log.info(
        `the plan came in ${Math.round((Date.now() - started) / 1000)}s: ${plan.reason ?? ''}`
      )
      return plan
    }
    log.warn(`the model's plan made no sense: ${response.message.content.slice(0, 200)}`)
  } catch (err) {
    log.warn(`no plan from the model (${errMsg(err)}); the default plan`)
  }
  return defaultPlan(names, soldiers)
}
