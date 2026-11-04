import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { OllamaClient } from '../ai/OllamaClient'
import { closeLogFiles, createLogger, logToFiles, setLogLevel, isLogLevel } from '../logger'
import type { CourtStatus } from '../status'
import { errMsg, sleep } from '../util'
import { drawLessons, writeReport, type SeriesFacts } from './lessons'
import { Playbook } from './playbook'
import {
  chestOf,
  league,
  objectiveOf,
  pairing,
  prepareCommands,
  resultOf,
  score,
  scoreMetals,
  type Arena,
  type Objective,
  type Score,
  type SideScore,
} from './referee'
import { botNames, SIDES } from './side'
import { readWar, total, type WarState } from './War'

/**
 * The referee of the war game (the King's experiment, 2026-11-02): runs the season round by
 * round. A round: two sides play (every pair in turn, the third side benched: its bots leave the
 * server), both their bases made anew and both mustered home (server commands on the war
 * server's console), `war reset` to both, peace for some days, then `war raid` to both at once,
 * the raid till both are done or time is up, `war end`, the score, each side's lessons into its
 * playbook; after a series of rounds, a report. State in <WAR_DIR>/season.json, so a restart
 * carries on. Needs: the war server's folder (its console.in, see server/run-bds.sh) and every
 * side's state folder (their command and war files).
 */
interface SeasonState {
  /** The season (arena.json), so a playbook tells this season's rounds from the last one's. */
  season?: number
  series: number
  round: number
  phase: 'prepare' | 'build' | 'raid' | 'score' | 'done'
  phaseAt: number
  results: Array<{ series: number; round: number; score: Score; at: number }>
}

interface RoundFile {
  season?: number
  series: number
  round: number
  /** The two sides that played it. */
  sides?: string[]
  startedAt: number
  orderedAt?: number
  endedAt?: number
  /** Each side's chest as its bots last saw it, at the order. */
  stockAtOrder?: Record<string, Record<string, number>>
  score?: Score
  lessons?: Record<string, string[]>
  states?: Record<string, WarState>
  /** What the round was won by, and (a metals round) each side's chest at the count. */
  objective?: Objective
  chests?: Record<string, Record<string, number>>
}

const WAR_DIR = path.resolve(process.env.WAR_DIR || '.war')
const SERVER_DIR = path.resolve(process.env.WAR_SERVER_DIR || 'server/war')
const ARENA_FILE = path.resolve(process.env.WAR_ARENA || 'config/war/arena.json')
const WAR_MODEL = process.env.OLLAMA_WAR_MODEL || 'gemma4:31b'
/** The sides' bots have this long to spawn before a round begins anyway. */
const MUSTER_MS = 10 * 60_000
/** A side's status older than this: its process is gone. */
const STALE_MS = 30_000
/** At a metals round's end each side has this long to count its chest. */
const COUNT_MS = 3 * 60_000

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function loadArena(): Arena {
  const raw = readJson<Partial<Arena>>(ARENA_FILE)
  if (!raw?.bases) throw new Error(`${ARENA_FILE}: no bases`)
  const num = (key: string, fallback: number) => {
    const v = Number(process.env[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  // The sides are those with a base, in the arena's order (which sets the fixtures).
  const sides: Record<string, string[]> = {}
  for (const side of Object.keys(raw.bases)) {
    if (!SIDES.includes(side))
      throw new Error(`${ARENA_FILE}: ${side} is no side (the sides: ${SIDES.join(', ')})`)
    sides[side] = botNames(path.resolve(`config/war/${side}.json`))
  }
  if (Object.keys(sides).length < 2) throw new Error(`${ARENA_FILE}: a war needs two sides`)
  return {
    season: num('WAR_SEASON', raw.season ?? 1),
    cycleMs: num('WAR_CYCLE_MS', raw.cycleMs ?? 20 * 60_000),
    buildCycles: num('WAR_BUILD_CYCLES', raw.buildCycles ?? 10),
    raidCycles: num('WAR_RAID_CYCLES', raw.raidCycles ?? 2),
    rounds: num('WAR_ROUNDS', raw.rounds ?? 3),
    series: num('WAR_SERIES', raw.series ?? 3),
    bases: raw.bases,
    sides,
    ...(raw.shared ? { shared: true } : {}),
    ...(raw.metals ? { metals: raw.metals } : {}),
  }
}

class Referee {
  private readonly log = createLogger('referee')
  private readonly seasonFile = path.join(WAR_DIR, 'season.json')
  private state: SeasonState
  private stopping = false
  private readonly ai: OllamaClient

  constructor(private readonly arena: Arena) {
    this.state = readJson<SeasonState>(this.seasonFile) ?? {
      season: arena.season,
      series: 1,
      round: 1,
      phase: 'prepare',
      phaseAt: Date.now(),
      results: [],
    }
    this.ai = new OllamaClient(
      {
        host: process.env.OLLAMA_HOST || 'http://ava:11434',
        model: process.env.OLLAMA_MODEL || 'gemma4:e4b',
        temperature: 0.5,
        timeoutMs: 10 * 60_000,
        keepAlive: '24h',
      },
      this.log.child('ollama')
    )
  }

  stop(): void {
    this.stopping = true
  }

  /** Every side, in the arena's order. */
  private get sides(): string[] {
    return Object.keys(this.arena.bases)
  }

  /** The two sides that play this round. */
  private playing(round = this.state.round): [string, string] {
    return pairing(this.sides, round)
  }

  /** The sides that sit this round out. */
  private sitting(): string[] {
    const playing = this.playing()
    return this.sides.filter((s) => !playing.includes(s))
  }

  private get season(): number {
    return this.state.season ?? this.arena.season
  }

  private save(): void {
    writeJson(this.seasonFile, this.state)
  }

  private sideDir(side: string): string {
    return path.join(WAR_DIR, side)
  }

  private roundFile(): string {
    return path.join(
      WAR_DIR,
      'rounds',
      `series-${this.state.series}-round-${this.state.round}.json`
    )
  }

  /** A command to the war server's console (run-bds.sh keeps console.in open). */
  private console(command: string): void {
    const fifo = path.join(SERVER_DIR, 'console.in')
    fs.appendFileSync(fifo, `${command}\n`)
    this.log.debug(`console: ${command}`)
  }

  /** An order to a side (its process reads and removes the file within a second). */
  private async order(side: string, line: string): Promise<void> {
    const file = path.join(this.sideDir(side), '.command')
    fs.mkdirSync(this.sideDir(side), { recursive: true })
    fs.appendFileSync(file, `${line}\n`)
    this.log.info(`to ${side}: ${line}`)
    for (let i = 0; i < 10 && fs.existsSync(file); i++) await sleep(1_000)
    if (fs.existsSync(file))
      this.log.warn(`${side} has not taken its order (is its court running?)`)
  }

  private status(side: string): CourtStatus | undefined {
    const s = readJson<CourtStatus>(path.join(this.sideDir(side), 'status-all.json'))
    return s && Date.now() - s.at < STALE_MS ? s : undefined
  }

  private war(side: string): WarState | undefined {
    return readWar(path.join(this.sideDir(side), 'war.json'))
  }

  private stock(side: string): Record<string, number> {
    return (
      readJson<{ stock?: Record<string, number> }>(path.join(this.sideDir(side), 'household.json'))
        ?.stock ?? {}
    )
  }

  private phase(phase: SeasonState['phase']): void {
    this.state.phase = phase
    this.state.phaseAt = Date.now()
    this.save()
    this.log.info(`series ${this.state.series}, round ${this.state.round}: ${phase}`)
  }

  private async waitUntil(when: number, poll = 30_000, until?: () => boolean): Promise<void> {
    while (!this.stopping && Date.now() < when && !until?.())
      await sleep(Math.min(poll, Math.max(1_000, when - Date.now())))
  }

  async run(): Promise<void> {
    const a = this.arena
    this.log.info(
      `the war game, season ${this.season}: ${a.series} series of ${a.rounds} rounds; ` +
        `${a.buildCycles} days of peace, ${a.raidCycles} of raid, a day being ` +
        `${Math.round(a.cycleMs / 60_000)} min; ` +
        Object.entries(a.bases)
          .map(([s, b]) => `${s} at ${b.home.x},${b.home.y},${b.home.z}`)
          .join(', ') +
        `; the rounds of a series: ` +
        Array.from({ length: a.rounds }, (_, i) => this.playing(i + 1).join(' v ')).join(', ')
    )
    while (!this.stopping && this.state.phase !== 'done') {
      try {
        if (this.state.series > a.series) {
          this.phase('done')
          break
        }
        switch (this.state.phase) {
          case 'prepare':
            await this.prepare()
            break
          case 'build':
            await this.waitUntil(this.state.phaseAt + a.buildCycles * a.cycleMs)
            if (this.stopping) break
            // A metals round ends here, with the count; a raid round goes on to the raid.
            if (this.objective() === 'metals') await this.endMetals()
            else await this.orderRaid()
            break
          case 'raid':
            await this.waitUntil(this.state.phaseAt + a.raidCycles * a.cycleMs, 15_000, () =>
              this.playing().every((s) => this.war(s)?.done)
            )
            if (!this.stopping) await this.endRaid()
            break
          case 'score':
            await this.score()
            break
        }
      } catch (err) {
        this.log.warn(`the round stumbled: ${errMsg(err)}; trying again in a minute`)
        await sleep(60_000)
      }
    }
    if (this.state.phase === 'done') this.log.info('the season is over')
  }

  /** The side a playing side plays this round. */
  private enemyOf(side: string): string {
    return this.playing().find((s) => s !== side)!
  }

  /**
   * A side benched or called in, and seen to be: an order written as the side's process starts
   * is lost (it clears its command file at start; on 2026-11-04 White missed its first bench
   * so, and the Dev world stood at its 25-player cap), so it goes again till the side's account
   * says it took it.
   */
  private async bench(side: string, on: boolean): Promise<void> {
    const line = on ? 'war bench' : 'war join'
    for (let i = 0; i < 6 && !this.stopping; i++) {
      await this.order(side, line)
      await sleep(3_000)
      // A side never benched has no say in it yet (a new side: no war file at all).
      if ((this.war(side)?.benched === true) === on) return
      this.log.info(`${side} has not taken "${line}" yet: again`)
      await sleep(10_000)
    }
    if (!this.stopping) this.log.warn(`${side} did not take "${line}": the round goes on anyway`)
  }

  /**
   * A new round: the side sitting it out benched (its bots leave the server), the two that play
   * called in, mustered home into new halls, and told.
   */
  private async prepare(): Promise<void> {
    const a = this.arena
    const playing = this.playing()
    this.log.info(
      `series ${this.state.series}, round ${this.state.round}: ${playing.join(' against ')}` +
        (this.sitting().length ? `; ${this.sitting().join(' and ')} sits it out` : '')
    )
    for (const side of this.sitting()) await this.bench(side, true)
    for (const side of playing) await this.bench(side, false)
    // The sides' bots in the world first (a teleport finds nobody otherwise).
    const start = Date.now()
    while (!this.stopping && Date.now() - start < MUSTER_MS) {
      // A status written since this began: after a restart the old files say everyone is in.
      const spawned = playing.map((s) => {
        const status = this.status(s)
        if (!status || status.at < start) return 0
        return status.bots.filter((b) => b.status === 'spawned').length
      })
      if (playing.every((s, i) => spawned[i] >= (a.sides[s]?.length ?? 0))) break
      this.log.info(`waiting for the sides to be in the world (${spawned.join(' and ')} spawned)`)
      await sleep(20_000)
    }
    if (this.stopping) return
    for (const cmd of prepareCommands(a, playing)) {
      this.console(cmd)
      await sleep(250)
    }
    await sleep(5_000)
    for (const side of playing) {
      const base = a.bases[side]
      const chest = chestOf(base)
      await this.order(
        side,
        `war reset ${this.state.series} ${this.state.round} ${base.home.x} ${base.home.y} ${base.home.z} ${chest.x} ${chest.y} ${chest.z}`
      )
    }
    const round: RoundFile = {
      season: this.season,
      series: this.state.series,
      round: this.state.round,
      sides: [...playing],
      startedAt: Date.now(),
    }
    // A metals round: anything goes from now on, both sides told at once.
    if (this.objective() === 'metals') {
      round.orderedAt = Date.now()
      await Promise.all(
        playing.map((side) => {
          const enemy = this.enemyOf(side)
          const base = a.bases[enemy]
          const chest = chestOf(base)
          return this.order(
            side,
            `war open ${chest.x} ${chest.y} ${chest.z} ${base.home.x} ${base.home.y} ${base.home.z} ${a.buildCycles} vs ${enemy}`
          )
        })
      )
    }
    writeJson(this.roundFile(), round)
    this.phase('build')
  }

  /** What this series' rounds are won by. */
  private objective(): Objective {
    return objectiveOf(this.arena, this.state.series)
  }

  /**
   * A metals round's end: everyone called off, then each side counts its own chest (a courtier
   * opens it); the count is waited for a few minutes, else the chest as last seen stands.
   */
  private async endMetals(): Promise<void> {
    await Promise.all(this.playing().map((side) => this.order(side, 'war end')))
    await sleep(15_000)
    const asked = Date.now()
    await Promise.all(this.playing().map((side) => this.order(side, 'war count')))
    await this.waitUntil(asked + COUNT_MS, 5_000, () =>
      this.playing().every((s) => (this.war(s)?.counted?.at ?? 0) >= asked)
    )
    for (const s of this.playing())
      if ((this.war(s)?.counted?.at ?? 0) < asked)
        this.log.warn(`${s} did not count its chest in time: the chest as last seen stands`)
    this.phase('score')
  }

  /** Each side's chest at the end of a metals round: its count, else as its bots last saw it. */
  private chests(states: WarState[]): Record<string, Record<string, number>> {
    return Object.fromEntries(states.map((s) => [s.side, s.counted?.items ?? this.stock(s.side)]))
  }

  /** Peace is over: both sides get the order at once. */
  private async orderRaid(): Promise<void> {
    const a = this.arena
    const round = readJson<RoundFile>(this.roundFile()) ?? {
      series: this.state.series,
      round: this.state.round,
      startedAt: this.state.phaseAt,
    }
    round.orderedAt = Date.now()
    round.stockAtOrder = Object.fromEntries(this.playing().map((s) => [s, this.stock(s)]))
    writeJson(this.roundFile(), round)
    await Promise.all(
      this.playing().map((side) => {
        const enemy = this.enemyOf(side)
        const base = a.bases[enemy]
        const chest = chestOf(base)
        return this.order(
          side,
          `war raid ${chest.x} ${chest.y} ${chest.z} ${base.home.x} ${base.home.y} ${base.home.z} vs ${enemy}`
        )
      })
    )
    this.phase('raid')
  }

  private async endRaid(): Promise<void> {
    await Promise.all(this.playing().map((side) => this.order(side, 'war end')))
    // Their files settle.
    await sleep(15_000)
    this.phase('score')
  }

  /** The score, each side's lessons, and after the last round of a series the report. */
  private async score(): Promise<void> {
    const a = this.arena
    // This round's accounts only: a side that missed its reset still has its last round's.
    const states = this.playing()
      .map((s) => this.war(s))
      .filter(
        (s): s is WarState =>
          s !== undefined && s.series === this.state.series && s.round === this.state.round
      )
    if (states.length < 2) {
      this.log.warn(
        'a side has no war file of this round; the round cannot be scored yet (did it miss its reset?)'
      )
      await sleep(30_000)
      return
    }
    const metals = this.objective() === 'metals'
    const chests = metals ? this.chests(states) : undefined
    const result = chests
      ? scoreMetals(states, a.sides, chests, a.metals?.points)
      : score(states, a.sides)
    this.log.info(
      `round ${this.state.round} of series ${this.state.series}: ` +
        (result.winner ? `${result.winner} won by ${result.decidedBy}` : 'a tie') +
        ` (${result.why})`
    )
    const round = readJson<RoundFile>(this.roundFile()) ?? {
      season: this.season,
      series: this.state.series,
      round: this.state.round,
      sides: [...this.playing()],
      startedAt: this.state.phaseAt,
    }
    round.endedAt = Date.now()
    round.score = result
    round.objective = metals ? 'metals' : 'raid'
    if (chests) round.chests = chests
    round.states = Object.fromEntries(states.map((s) => [s.side, s]))
    round.lessons = {}
    for (const state of states) {
      const playbook = new Playbook(path.join(this.sideDir(state.side), 'playbook.json'))
      const before = playbook.forPlanning().lessons
      const other = states.find((s) => s.side !== state.side)
      const chest = (side: string) => total(round.stockAtOrder?.[side] ?? {})
      const lessons = await drawLessons(
        this.ai,
        {
          series: this.state.series,
          round: this.state.round,
          state,
          other,
          score: result,
          stock: other ? { mine: chest(state.side), theirs: chest(other.side) } : undefined,
          objective: metals ? 'metals' : 'raid',
          chests:
            chests && other
              ? { mine: chests[state.side] ?? {}, theirs: chests[other.side] ?? {} }
              : undefined,
          playbook: before,
        },
        this.log,
        { model: WAR_MODEL }
      )
      round.lessons[state.side] = lessons
      playbook.learn(
        {
          season: this.season,
          series: this.state.series,
          round: this.state.round,
          result: resultOf(result, state.side),
          text: result.why,
        },
        lessons
      )
      for (const l of lessons) this.log.info(`${state.side} learned: ${l}`)
    }
    writeJson(this.roundFile(), round)
    this.state.results.push({
      series: this.state.series,
      round: this.state.round,
      score: result,
      at: Date.now(),
    })
    this.writeTable()
    if (this.state.round >= a.rounds) {
      await this.report()
      this.state.series++
      this.state.round = 1
    } else this.state.round++
    this.phase('prepare')
  }

  /**
   * The season so far (season.md), for a look at the curve: every game, the two sides' figures
   * side by side (the first named first), and the league table.
   */
  private writeTable(): void {
    const results = this.state.results
    const metals = results.some((r) => r.score.sides.some((s) => s.points !== undefined))
    const rows = results.map((r) => {
      const [x, y] = r.score.sides
      const both = (f: (s: SideScore) => number | undefined) =>
        x && y ? `${f(x) ?? ''} – ${f(y) ?? ''}` : ''
      const cells = [
        `${x?.side ?? '?'} v ${y?.side ?? '?'}`,
        r.score.winner ?? 'tie',
        r.score.decidedBy,
        ...(metals ? [both((s) => s.points)] : []),
        both((s) => s.brought),
        both((s) => s.lost),
        both((s) => s.kills),
        both((s) => s.deaths),
        both((s) => s.trips),
      ]
      return `| ${r.series} | ${r.round} | ${cells.join(' | ')} |`
    })
    const standings = league(results, this.sides).map(
      (s) =>
        `| ${s.side} | ${s.played} | ${s.won} | ${s.lost} | ${s.tied} | ${s.itemsFor} | ${s.itemsAgainst} | ` +
        `${s.itemsFor - s.itemsAgainst} | ${s.kills} | ${s.killed} | ${s.deaths} |`
    )
    const text = [
      `# The war game, season ${this.season}, so far`,
      '',
      '## The games',
      '',
      "(each pair of figures: the first side named, then the second; brought: items from the other's chest put in its own)",
      '',
      `| series | round | game | winner | by | ${metals ? 'points | ' : ''}brought | lost | kills | deaths | trips |`,
      `|---|---|---|---|---|${metals ? '---|' : ''}---|---|---|---|---|`,
      ...rows,
      '',
      '## The league',
      '',
      '| side | played | won | lost | tied | items for | items against | difference | kills | killed by the other | deaths |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...standings,
      '',
    ].join('\n')
    fs.writeFileSync(path.join(WAR_DIR, 'season.md'), text)
  }

  private async report(): Promise<void> {
    const series = this.state.series
    const rounds = this.state.results
      .filter((r) => r.series === series)
      .map((r) => {
        const file = readJson<RoundFile>(
          path.join(WAR_DIR, 'rounds', `series-${series}-round-${r.round}.json`)
        )
        return {
          round: r.round,
          score: r.score,
          plans: Object.fromEntries(r.score.sides.map((s) => [s.side, s.plan])),
          lessons: file?.lessons ?? {},
        }
      })
    const lessons: Record<string, string[]> = {}
    for (const side of this.sides) lessons[side] = rounds.flatMap((r) => r.lessons[side] ?? [])
    const before = [
      ...new Set(this.state.results.filter((r) => r.series < series).map((r) => r.series)),
    ].map((s) => {
      const won = (side: string) =>
        this.state.results.filter((r) => r.series === s && r.score.winner === side).length
      return `series ${s}: ${this.sides.map((side) => `${side} won ${won(side)}`).join(', ')}`
    })
    const facts: SeriesFacts = { series, rounds, lessons, before }
    const text = await writeReport(this.ai, facts, this.log, { model: WAR_MODEL })
    const table = fs.existsSync(path.join(WAR_DIR, 'season.md'))
      ? fs.readFileSync(path.join(WAR_DIR, 'season.md'), 'utf8')
      : ''
    fs.writeFileSync(
      path.join(WAR_DIR, `series-${series}.md`),
      `# Series ${series}\n\n${text || '(the model wrote no report)'}\n\n${table}`
    )
    this.log.info(`the report on series ${series} is written`)
  }
}

async function main(): Promise<void> {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase()
  if (isLogLevel(level)) setLogLevel(level)
  if (process.env.LOG_DIR !== '')
    logToFiles(path.resolve(process.env.LOG_DIR || path.join(WAR_DIR, 'logs')))
  const referee = new Referee(loadArena())
  const stop = async (why: string) => {
    referee.stop()
    createLogger('referee').info(`${why}: stopping after this step`)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
  await referee.run()
  await closeLogFiles()
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
