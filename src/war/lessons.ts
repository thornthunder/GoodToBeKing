import type { ChatModel } from '../ai/OllamaClient'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { metalWords, resultOf, timeline, type Score } from './referee'
import type { WarState } from './War'

/**
 * What a side learns from a round, and the report on a series. The lessons are drawn by the
 * model from the side's own account only (what it saw and did, and the score), and go into its
 * playbook; the captain reads them when planning the next raid. The report is for the King.
 */
const LESSONS_SCHEMA = {
  type: 'object',
  properties: { lessons: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
  required: ['lessons'],
}

const LESSONS_GUIDE = `You are the captain of one side in a war game between courts on a Minecraft survival server. The courts play a league: each round two of them play each other, so the side you face may change from round to round.
Each round, both sides are ordered at once to raid each other's storehouse chest. The side that brings more of the other's items home and into its own chest wins; kills break a tie.
A round has just ended. Below is the full picture of it, for both sides: each side's plan and the reason its captain gave, how each side stood when the order came (every courtier's weapons, armour, health and food), what each chest held, what each side did and what happened to it, in order, and the score.
Draw one to three lessons for your next plan, from the whole picture: what won and what lost, for you and for them. Each lesson is one plain sentence, concrete and actionable (who should go or stay, which tactic, when, how many trips, what arms or armour to have, what to watch for), and must follow from what happened in this round. When a lesson is about the side you faced, name that side. Do not repeat a lesson already in the playbook unless this round confirmed it strongly; then say so in it.
Answer with JSON only: {"lessons": ["...", "..."]}`

const METALS_GUIDE = `You are the captain of one side in a war game between courts on a Minecraft survival server. The courts play a league: each round two of them play each other, so the side you face may change from round to round.
In this round, after ten Minecraft days the side with the most metal bars in its own storehouse chest won: a gold bar 100 points, an iron bar 25, a copper bar 10; only bars in the chest counted; kills broke a tie. Anything went: mining and smelting, raiding the other side's chest, guarding one's own. Once a day each captain held a council: who raids, who guards the chest, whether bars may be spent on arms (swords, armour) or on tools (an iron pickaxe for gold ore, a bucket).
The round has just ended. Below is the full picture of it, for both sides: each side's councils day by day, how each side stood at the start (every courtier's weapons, armour, health and food), each chest at the count, what each side did and saw, in order, and how often each side died and at whose hands.
Draw one to three lessons for your next round, from the whole picture: what won and what lost, for you and for them. Each lesson is one plain sentence, concrete and actionable (how many to mine, raid or guard, when to raid, whether to spend bars on arms or a pickaxe, what to watch for), and must follow from what happened in this round. When a lesson is about the side you faced, name that side. Do not repeat a lesson already in the playbook unless this round confirmed it strongly; then say so in it.
Answer with JSON only: {"lessons": ["...", "..."]}`

export interface RoundFacts {
  series: number
  round: number
  state: WarState
  /** The other side's account (both sides see the whole round, the King's wish, 2026-11-03). */
  other?: WarState
  score: Score
  /** What each chest held when the order came, in items. */
  stock?: { mine: number; theirs: number }
  /** What the round was won by; a metals round's chests at the count. */
  objective?: 'raid' | 'metals'
  chests?: { mine: Record<string, number>; theirs: Record<string, number> }
  /** The playbook before this round, newest first. */
  playbook: string[]
}

/** How often a side died in the round, and at whose hands (a metals round lists no deaths one by one). */
function deathWords(state: WarState, enemyNames: Set<string>): string {
  const t0 = state.orderedAt ?? 0
  const deaths = state.events.filter((e) => e.kind === 'death' && e.at >= t0)
  const ours = deaths.filter((e) => !enemyNames.has((e.who ?? '').toLowerCase()))
  const byThem = ours.filter((e) => e.by && enemyNames.has(e.by.toLowerCase()))
  const killers = new Map<string, number>()
  for (const e of ours) {
    const why = e.by ?? (e.text ?? '').replace(/^death\.(attack\.)?/, '').split('.')[0]
    killers.set(why, (killers.get(why) ?? 0) + 1)
  }
  const top = [...killers]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${n} by ${k}`)
    .join(', ')
  return `died ${ours.length} times, ${byThem.length} of them at the other side's hands${top ? ` (${top})` : ''}`
}

function metalsBrief(f: RoundFacts): string {
  const mine = f.score.sides.find((s) => s.side === f.state.side)
  const theirs = f.score.sides.find((s) => s.side !== f.state.side)
  const result = resultOf(f.score, f.state.side)
  const other = theirs?.side ?? f.other?.side ?? 'the other side'
  const names = (state: WarState | undefined) =>
    new Set((state?.enemy?.names ?? []).map((n) => n.toLowerCase()))
  const raids = (s: typeof mine) =>
    s
      ? `took ${s.brought + s.lost} items from the other chest, brought ${s.brought} home and lost ${s.lost} on the way, put back ${s.recovered} of its own, killed ${s.kills} of the other side`
      : 'unknown'
  const told = (state: WarState | undefined) =>
    state ? timeline({ ...state, events: state.events.filter((e) => e.kind !== 'death') }, 60) : []
  const chest = (items: Record<string, number> | undefined) =>
    items ? metalWords(items) : 'not counted'
  return [
    `Series ${f.series}, round ${f.round}: your side (${f.state.side}) ${result === 'tie' ? 'tied' : result}. ${f.score.why}.`,
    `Your chest at the count: ${chest(f.chests?.mine)}. Theirs (${other}): ${chest(f.chests?.theirs)}.`,
    `Your side ${raids(mine)}; it ${deathWords(f.state, names(f.state))}.`,
    `The other side ${raids(theirs)}; it ${f.other ? deathWords(f.other, names(f.other)) : 'died an unknown number of times'}.`,
    'Your side at the start:',
    ...musterLines(f.state),
    `The other side (${other}) at the start:`,
    ...(f.other ? musterLines(f.other) : ['- (unknown)']),
    'What your side did and saw, in order (councils, raids, what the chests held):',
    ...told(f.state).map((l) => `- ${l}`),
    ...(f.other
      ? [
          `What the other side (${other}) did and saw, in order:`,
          ...told(f.other).map((l) => `- ${l}`),
        ]
      : []),
    f.playbook.length
      ? `Your playbook so far:\n${f.playbook.map((l) => `- ${l}`).join('\n')}`
      : 'Your playbook is empty so far.',
    'Write the lessons.',
  ].join('\n')
}

/** The side as it stood when the order came, a line per courtier. */
function musterLines(state: WarState): string[] {
  if (!state.muster?.length) return ['- (not recorded)']
  return state.muster.map(
    (m) =>
      `- ${m.name}, ${m.role}: ${m.gear}; health ${m.health ?? '?'}/20, food ${m.food ?? '?'}/20`
  )
}

export function lessonsBrief(f: RoundFacts): string {
  if (f.objective === 'metals') return metalsBrief(f)
  const mine = f.score.sides.find((s) => s.side === f.state.side)
  const theirs = f.score.sides.find((s) => s.side !== f.state.side)
  const result = resultOf(f.score, f.state.side)
  const line = (s: typeof mine) =>
    s
      ? `brought ${s.brought} items home, lost ${s.lost} on the way, put ${s.recovered} of its own back, ${s.kills} kills, ${s.deaths} deaths, ${s.trips} trips home with loot` +
        (s.firstGrabMin !== undefined
          ? `, first loot taken after ${s.firstGrabMin} min`
          : ', never took anything')
      : 'unknown'
  const plan = (state: WarState | undefined, s: typeof mine) =>
    `${s?.plan ?? 'none'}${state?.plan?.reason ? ` (reason given: ${state.plan.reason})` : ''}`
  const side = (
    title: string,
    state: WarState | undefined,
    s: typeof mine,
    chest: number | undefined
  ) => [
    `${title}: ${line(s)}.`,
    `${title}'s plan: ${plan(state, s)}.`,
    `${title} when the order came${chest !== undefined ? ` (its chest held ${chest} items)` : ''}:`,
    ...(state ? musterLines(state) : ['- (unknown)']),
  ]
  const other = theirs?.side ?? f.other?.side ?? 'the other side'
  return [
    `Series ${f.series}, round ${f.round}: your side (${f.state.side}) ${result === 'tie' ? 'tied' : result}. ${f.score.why}.`,
    ...side('Your side', f.state, mine, f.stock?.mine),
    ...side(`The other side (${other})`, f.other, theirs, f.stock?.theirs),
    'What your side saw, in order:',
    ...timeline(f.state).map((l) => `- ${l}`),
    ...(f.other
      ? [`What the other side (${other}) saw, in order:`, ...timeline(f.other).map((l) => `- ${l}`)]
      : []),
    f.playbook.length
      ? `Your playbook so far:\n${f.playbook.map((l) => `- ${l}`).join('\n')}`
      : 'Your playbook is empty so far.',
    'Write the lessons.',
  ].join('\n')
}

/** The side's lessons from the round; none when the model does not answer. */
export async function drawLessons(
  model: ChatModel,
  facts: RoundFacts,
  log: Logger,
  opts: { model?: string; timeoutMs?: number } = {}
): Promise<string[]> {
  try {
    const response = await model.chat(
      [
        {
          role: 'system',
          content: facts.objective === 'metals' ? METALS_GUIDE : LESSONS_GUIDE,
        },
        { role: 'user', content: lessonsBrief(facts) },
      ],
      {
        model: opts.model,
        shared: Boolean(opts.model),
        format: LESSONS_SCHEMA,
        temperature: 0.5,
        think: false,
        stream: true,
        timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      }
    )
    const parsed = JSON.parse(response.message.content) as { lessons?: unknown }
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons
          .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          .map((l) => l.trim().slice(0, 400))
          .slice(0, 3)
      : []
    log.info(`${facts.state.side} drew ${lessons.length} lesson(s) from round ${facts.round}`)
    return lessons
  } catch (err) {
    log.warn(`${facts.state.side} drew no lessons (${errMsg(err)})`)
    return []
  }
}

export interface SeriesFacts {
  series: number
  rounds: Array<{ round: number; score: Score; plans: Record<string, string | undefined> }>
  /** Each side's lessons after each round of the series. */
  lessons: Record<string, string[]>
  /** The sides' results in earlier series, a line each. */
  before: string[]
}

/**
 * The referee's guide. Season 2 (the King's wish, 2026-11-04): a league of three sides, Blue
 * and Green with a season's playbooks behind them and White new, with an empty one; each round
 * two play and the third sits it out, every pair in turn.
 */
const REPORT_GUIDE = `You are the referee of a war game between courts on a Minecraft survival server.
This season three sides play a league: Blue and Green, who played a season against each other before and carry its lessons in their playbooks, and White, new this season with an empty playbook. Each round two of the sides play each other and the third sits it out, every pair in turn.
In a round both sides live apart for some days, then are ordered at once to raid each other's storehouse chest; the side that brings more of the other's items home wins, kills break a tie. Each round's line says who played and what decided it.
All sides run on identical code and the same model; after each round each side that played draws lessons from the whole round (both sides' accounts) into its playbook, which its captain reads when planning. So the only thing that sets the sides apart over time is what they have been through.
A series of rounds has just ended. Write a short report for the King in Markdown: a few paragraphs on why the winners won and the losers lost, what each side learned and whether its lessons were sound, what changed from round to round, and what to watch in the next series. Be concrete; cite the rounds. Do not invent events not in the facts. No headings above level 3.`

export function seriesBrief(f: SeriesFacts): string {
  const rounds = f.rounds.map((r) => {
    const sides = r.score.sides
      .map(
        (s) =>
          `${s.side}: ${s.brought} brought home, ${s.lost} lost, ${s.kills} kills, ${s.deaths} deaths, ${s.trips} trips` +
          (s.plan ? `; plan ${s.plan}` : '')
      )
      .join(' | ')
    const game = r.score.sides.map((s) => s.side).join(' against ')
    return `Round ${r.round}, ${game}: ${r.score.winner ? `${r.score.winner} won by ${r.score.decidedBy}` : 'a tie'} (${r.score.why}). ${sides}`
  })
  const lessons = Object.entries(f.lessons).map(
    ([side, ls]) => `${side}:\n${ls.length ? ls.map((l) => `- ${l}`).join('\n') : '- (none)'}`
  )
  return [
    `Series ${f.series}.`,
    f.before.length ? `Earlier series:\n${f.before.map((b) => `- ${b}`).join('\n')}` : '',
    'The rounds:',
    ...rounds,
    'The lessons each side drew during this series (in order):',
    ...lessons,
    'Write the report.',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function writeReport(
  model: ChatModel,
  facts: SeriesFacts,
  log: Logger,
  opts: { model?: string; timeoutMs?: number } = {}
): Promise<string> {
  try {
    const response = await model.chat(
      [
        { role: 'system', content: REPORT_GUIDE },
        { role: 'user', content: seriesBrief(facts) },
      ],
      {
        model: opts.model,
        shared: Boolean(opts.model),
        temperature: 0.5,
        think: false,
        stream: true,
        timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      }
    )
    return response.message.content.trim()
  } catch (err) {
    log.warn(`no report for series ${facts.series} (${errMsg(err)})`)
    return ''
  }
}
