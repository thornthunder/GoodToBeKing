import type { ChatModel } from '../ai/OllamaClient'
import type { Point } from '../build/site'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { gearWords, type Member } from './plan'
import { METAL_POINTS, metalWords } from './referee'
import { TACTICS, type Plan, type Tactic } from './War'

/**
 * The captain's council in a metals round (the King's rule for series 3, 2026-11-03): after ten
 * days the side with the most metal bars in its own chest wins, by any means. Once a day the
 * captain decides who raids the other side's chest, who guards ours, and whether bars may be
 * spent on arms or on tools; everyone else goes about the court's work (the mine, the furnace).
 * The model decides from the brief and the playbook; code carries it out. Both sides run this.
 */
export interface CouncilMember extends Member {
  /** What it is doing now ("raiding", "holding the chest", "mining"...). */
  doing?: string
}

export interface CouncilBrief {
  side: string
  captain: string
  enemySide: string
  /** Day of the round (1-based), and the days it lasts. */
  day: number
  days: number
  members: CouncilMember[]
  /** Our chest as last seen. */
  stock: Record<string, number>
  home: Point
  enemyChest: Point
  night: boolean
  /** What a raider of ours last saw in the other side's chest, and how many minutes ago. */
  enemySeen?: { items: Record<string, number>; minutesAgo: number }
  /** Gold ore our miner saw and had to leave, for want of an iron pickaxe. */
  goldSeen: number
  /** We have an iron pickaxe (in the chest or a pocket). */
  ironPickaxe: boolean
  /** Raiders still out on a raid (they carry on; not to be named again). */
  onRaid: string[]
  /** What happened since the last council, a line each. */
  recent: string[]
  /** Lessons from past rounds (newest first), and how the last rounds went. */
  playbook: string[]
  record: string[]
}

export interface Council extends Plan {
  /** May bars be spent on swords and armour; on an iron pickaxe and a bucket? */
  arms: boolean
  tools: boolean
}

export const COUNCIL_SCHEMA = {
  type: 'object',
  properties: {
    raiders: { type: 'array', items: { type: 'string' } },
    defenders: { type: 'array', items: { type: 'string' } },
    tactic: { type: 'string', enum: TACTICS },
    trips: { type: 'integer', minimum: 1, maximum: 5 },
    arms: { type: 'boolean' },
    tools: { type: 'boolean' },
    words: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['raiders', 'defenders', 'tactic', 'trips', 'arms', 'tools', 'words', 'reason'],
}

const GUIDE = `You are the captain of one side in a war game between two courts of a Minecraft survival server (Normal difficulty, PvP on).
This round has new rules. After ten Minecraft days (a day is twenty minutes), the side with the most metal bars in its own storehouse chest wins: a gold bar is worth 100 points, an iron bar 25, a copper bar 10. Only bars in our chest count: raw ore, bars in someone's pockets, and swords, armour or tools made of metal count for nothing. If the points are equal, the side that killed more of the other side wins.
Anything goes: mine and smelt, take bars from the other side's chest, guard our own. The other side plays by the same rules and knows where our chest is.
How the court works: anyone you do not name as a raider or a defender goes about the court's work. One courtier digs the court's mine (iron and copper ore need a stone pickaxe; gold ore needs an iron pickaxe, and the miner leaves gold it cannot take); someone smelts the ore into bars in the hall's furnace (fuel: coal from the mine, charcoal from logs); others fell wood, hunt, farm and keep the hall. Everything ends up in our chest.
Once a day you decide:
- raiders: who goes to the other side's chest now, takes what they can carry (bars first, then ore), brings it home and puts it in our chest, then goes again, up to "trips" times. An empty list sends nobody today. Raiders still out from before carry on; do not name them.
- defenders: who stays by our chest until your next council and fights any enemy who comes near. Defenders do no other work.
- tactic for the raiders: "rush" = take and run, fighting only when struck; "fight" = kill the defenders by their chest first; "wait" = hold off near their home until their chest is unguarded.
- trips: 1 to 5.
- arms: may bars from our chest be made into swords and armour? Every bar spent is points lost, but armed courtiers win fights.
- tools: may three iron bars (75 points) be made into an iron pickaxe, so the miner can take gold ore (100 points a bar), and iron into a bucket for the field?
A dead courtier wakes at home after a moment, without what it carried. Weigh what our chest holds and is worth, what we saw in theirs, how many days are left, who is fit and armed, night and day, and above all what the playbook says happened before.
Answer with JSON only: {"raiders": [...], "defenders": [...], "tactic": "...", "trips": n, "arms": true|false, "tools": true|false, "words": "one short line to your side", "reason": "two sentences on why"}.`

export function councilWords(b: CouncilBrief): string {
  const members = b.members.map(
    (m) =>
      `- ${m.name}${m.name === b.captain ? ' (you, the captain)' : ''}, ${m.role}: ${gearWords(m)}; ` +
      `health ${m.health ?? '?'}/20, food ${m.food ?? '?'}/20; ${m.home ? 'at home' : 'away from home'}` +
      (m.doing ? `; ${m.doing}` : '')
  )
  const other = Object.entries(b.stock)
    .filter(([n]) => !(n in METAL_POINTS))
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([n, k]) => `${k} ${n}`)
  const dx = b.enemyChest.x - b.home.x
  const dz = b.enemyChest.z - b.home.z
  const dir = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north'
  return [
    `You are ${b.captain}, captain of the ${b.side} side; the other side is ${b.enemySide}.`,
    `It is day ${b.day} of ${b.days}${b.day >= b.days ? ' (the last)' : ''}; it is ${b.night ? 'night' : 'day'} now.`,
    `Our chest holds ${metalWords(b.stock)}${other.length ? `, and ${other.join(', ')}` : ''}.`,
    b.enemySeen
      ? `${b.enemySeen.minutesAgo} minutes ago their chest held ${metalWords(b.enemySeen.items)}.`
      : 'Nobody of ours has looked into their chest yet.',
    `Their chest is ${Math.round(Math.hypot(dx, dz))} blocks to the ${dir}.`,
    `Our mine: ${b.ironPickaxe ? 'we have an iron pickaxe' : 'no iron pickaxe'}` +
      (b.goldSeen ? `; the miner saw ${b.goldSeen} gold ore and had to leave it.` : '.'),
    `Your side (${b.members.length}):`,
    ...members,
    b.onRaid.length ? `Still out raiding: ${b.onRaid.join(', ')}.` : 'Nobody is out raiding.',
    b.recent.length
      ? `Since the last council:\n${b.recent.map((l) => `- ${l}`).join('\n')}`
      : 'Nothing has happened yet.',
    b.record.length
      ? `Past rounds:\n${b.record.map((r) => `- ${r}`).join('\n')}`
      : 'This is the first round.',
    b.playbook.length
      ? `Your playbook (lessons from past rounds, newest first):\n${b.playbook.map((l) => `- ${l}`).join('\n')}`
      : 'Your playbook is empty: nothing has been learned yet.',
    "Decide today's plan.",
  ].join('\n')
}

/**
 * The model's answer as a council: names not of the side, or out raiding already, are dropped;
 * nobody both raids and defends; the rest work. Undefined when it is no answer at all.
 */
export function parseCouncil(
  raw: unknown,
  names: string[],
  onRaid: string[] = [],
  by: Plan['by'] = 'model'
): Council | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  const byName = new Map(names.map((n) => [n.toLowerCase(), n]))
  const out = new Set(onRaid.map((n) => n.toLowerCase()))
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .map((v) => byName.get(String(v).trim().toLowerCase()))
              .filter((n): n is string => n !== undefined && !out.has(n.toLowerCase()))
          ),
        ]
      : []
  if (!Array.isArray(p.raiders) && !Array.isArray(p.defenders)) return undefined
  const raiders = list(p.raiders)
  const defenders = list(p.defenders).filter((n) => !raiders.includes(n))
  const tactic = TACTICS.includes(p.tactic as Tactic) ? (p.tactic as Tactic) : 'rush'
  const trips = Math.min(5, Math.max(1, Math.round(Number(p.trips)) || 1))
  const text = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined
  return {
    raiders,
    defenders,
    tactic,
    when: 'now',
    trips,
    arms: p.arms === true,
    tools: p.tools === true,
    words: text(p.words),
    reason: text(p.reason),
    by,
  }
}

/** Without the model: nobody raids, one soldier guards the chest, no bars spent but on a pickaxe for gold seen. */
export function defaultCouncil(
  names: string[],
  soldiers: string[],
  goldSeen: number,
  onRaid: string[] = []
): Council {
  const guard = soldiers.find((n) => !onRaid.includes(n))
  return parseCouncil(
    {
      raiders: [],
      defenders: guard ? [guard] : [],
      tactic: 'rush',
      trips: 1,
      arms: false,
      tools: goldSeen > 0,
      words: 'To work, all of you: the mine and the furnace. One of you, guard the chest.',
      reason: 'The default council: everyone works, one soldier guards the chest.',
    },
    names,
    onRaid,
    'default'
  )!
}

/** "raiders Brock, Bevis (rush, 3 trips); defenders Bram; arms no, tools yes". */
export function councilLine(c: Council): string {
  return (
    (c.raiders.length
      ? `raiders ${c.raiders.join(', ')} (${c.tactic}, ${c.trips} trip(s))`
      : 'no raid') +
    `; defenders ${c.defenders.join(', ') || 'none'}; arms ${c.arms ? 'yes' : 'no'}, tools ${c.tools ? 'yes' : 'no'}`
  )
}

/** Ask the model for the day's council; the default when it does not answer or makes no sense. */
export async function holdCouncil(
  model: ChatModel,
  brief: CouncilBrief,
  soldiers: string[],
  log: Logger,
  opts: { model?: string; timeoutMs?: number } = {}
): Promise<Council> {
  const names = brief.members.map((m) => m.name)
  const started = Date.now()
  try {
    const response = await model.chat(
      [
        { role: 'system', content: GUIDE },
        { role: 'user', content: councilWords(brief) },
      ],
      {
        model: opts.model,
        shared: Boolean(opts.model),
        format: COUNCIL_SCHEMA,
        temperature: 0.6,
        think: false,
        timeoutMs: opts.timeoutMs ?? 90_000,
        priority: 'urgent',
      }
    )
    const council = parseCouncil(JSON.parse(response.message.content), names, brief.onRaid)
    if (council) {
      log.info(
        `the council took ${Math.round((Date.now() - started) / 1000)}s: ${council.reason ?? ''}`
      )
      return council
    }
    log.warn(`the council made no sense: ${response.message.content.slice(0, 200)}`)
  } catch (err) {
    log.warn(`no council from the model (${errMsg(err)}); the default`)
  }
  return defaultCouncil(names, soldiers, brief.goldSeen, brief.onRaid)
}
