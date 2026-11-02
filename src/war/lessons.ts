import type { ChatModel } from '../ai/OllamaClient'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { resultOf, timeline, type Score } from './referee'
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

const LESSONS_GUIDE = `You are the captain of one side in a war game between two courts on a Minecraft survival server.
Each round, both sides are ordered at once to raid each other's storehouse chest. The side that brings more of the other's items home and into its own chest wins; kills break a tie.
A round has just ended. Below is your side's own account of it: your plan, what your courtiers did and what happened to them, and the score.
Draw one to three lessons for your next plan. Each lesson is one plain sentence, concrete and actionable (who should go or stay, which tactic, when, how many trips, what to watch for), and must follow from what happened in this round. Do not repeat a lesson already in the playbook unless this round confirmed it strongly; then say so in it.
Answer with JSON only: {"lessons": ["...", "..."]}`

export interface RoundFacts {
  series: number
  round: number
  state: WarState
  score: Score
  /** The playbook before this round, newest first. */
  playbook: string[]
}

export function lessonsBrief(f: RoundFacts): string {
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
  return [
    `Series ${f.series}, round ${f.round}: your side (${f.state.side}) ${result === 'tie' ? 'tied' : result}. ${f.score.why}.`,
    `Your side: ${line(mine)}.`,
    `The other side (${theirs?.side ?? '?'}): ${line(theirs)}.`,
    `Your plan: ${mine?.plan ?? 'none'}${f.state.plan?.reason ? ` (reason given: ${f.state.plan.reason})` : ''}.`,
    'What your side saw, in order:',
    ...timeline(f.state).map((l) => `- ${l}`),
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
        { role: 'system', content: LESSONS_GUIDE },
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

const REPORT_GUIDE = `You are the referee of a war game between two courts on a Minecraft survival server, Blue and Green.
Each round, both sides live apart for some days, then are ordered at once to raid each other's storehouse chest; the side that brings more of the other's items home wins, kills break a tie.
Both sides run on identical code and the same model; after each round each side draws lessons from its own account into its playbook, which its captain reads when planning the next raid. So the only thing that sets the sides apart over time is what they have been through.
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
    return `Round ${r.round}: ${r.score.winner ? `${r.score.winner} won by ${r.score.decidedBy}` : 'a tie'} (${r.score.why}). ${sides}`
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
