import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { OllamaClient } from '../ai/OllamaClient'
import { closeLogFiles, createLogger, logToFiles, setLogLevel, isLogLevel } from '../logger'
import type { CourtStatus } from '../status'
import { errMsg, sleep } from '../util'
import { drawLessons, writeReport, type SeriesFacts } from './lessons'
import { Playbook } from './playbook'
import { chestOf, prepareCommands, resultOf, score, type Arena, type Score } from './referee'
import { botNames, SIDES } from './side'
import { readWar, total, type WarState } from './War'

/**
 * The referee of the war game (the King's experiment, 2026-11-02): runs the season round by
 * round. A round: both bases made anew and both sides mustered home (server commands on the
 * war server's console), `war reset` to both sides, peace for some days, then `war raid` to both
 * at once, the raid till both are done or time is up, `war end`, the score, each side's lessons
 * into its playbook; after a series of rounds, a report. State in <WAR_DIR>/season.json, so a
 * restart carries on. Needs: the war server's folder (its console.in, see server/run-bds.sh)
 * and both sides' state folders (their command and war files).
 */
interface SeasonState {
  series: number
  round: number
  phase: 'prepare' | 'build' | 'raid' | 'score' | 'done'
  phaseAt: number
  results: Array<{ series: number; round: number; score: Score; at: number }>
}

interface RoundFile {
  series: number
  round: number
  startedAt: number
  orderedAt?: number
  endedAt?: number
  /** Each side's chest as its bots last saw it, at the order. */
  stockAtOrder?: Record<string, Record<string, number>>
  score?: Score
  lessons?: Record<string, string[]>
  states?: Record<string, WarState>
}

const WAR_DIR = path.resolve(process.env.WAR_DIR || '.war')
const SERVER_DIR = path.resolve(process.env.WAR_SERVER_DIR || 'server/war')
const ARENA_FILE = path.resolve(process.env.WAR_ARENA || 'config/war/arena.json')
const WAR_MODEL = process.env.OLLAMA_WAR_MODEL || 'gemma4:31b'
/** The sides' bots have this long to spawn before a round begins anyway. */
const MUSTER_MS = 10 * 60_000
/** A side's status older than this: its process is gone. */
const STALE_MS = 30_000

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
  const sides: Record<string, string[]> = {}
  for (const side of SIDES) {
    if (!raw.bases[side]) throw new Error(`${ARENA_FILE}: no base for ${side}`)
    sides[side] = botNames(path.resolve(`config/war/${side}.json`))
  }
  return {
    cycleMs: num('WAR_CYCLE_MS', raw.cycleMs ?? 20 * 60_000),
    buildCycles: num('WAR_BUILD_CYCLES', raw.buildCycles ?? 10),
    raidCycles: num('WAR_RAID_CYCLES', raw.raidCycles ?? 2),
    rounds: num('WAR_ROUNDS', raw.rounds ?? 3),
    series: num('WAR_SERIES', raw.series ?? 3),
    bases: raw.bases,
    sides,
    ...(raw.shared ? { shared: true } : {}),
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
      `the war game: ${a.series} series of ${a.rounds} rounds; ${a.buildCycles} days of peace, ` +
        `${a.raidCycles} of raid, a day being ${Math.round(a.cycleMs / 60_000)} min; ` +
        Object.entries(a.bases)
          .map(([s, b]) => `${s} at ${b.home.x},${b.home.y},${b.home.z}`)
          .join(', ')
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
            if (!this.stopping) await this.orderRaid()
            break
          case 'raid':
            await this.waitUntil(this.state.phaseAt + a.raidCycles * a.cycleMs, 15_000, () =>
              SIDES.every((s) => this.war(s)?.done)
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

  /** A new round: both sides mustered home into new halls, and told. */
  private async prepare(): Promise<void> {
    const a = this.arena
    // The sides' bots in the world first (a teleport finds nobody otherwise).
    const start = Date.now()
    while (!this.stopping && Date.now() - start < MUSTER_MS) {
      // A status written since this began: after a restart the old files say everyone is in.
      const spawned = SIDES.map((s) => {
        const status = this.status(s)
        if (!status || status.at < start) return 0
        return status.bots.filter((b) => b.status === 'spawned').length
      })
      if (SIDES.every((s, i) => spawned[i] >= (a.sides[s]?.length ?? 0))) break
      this.log.info(`waiting for the sides to be in the world (${spawned.join(' and ')} spawned)`)
      await sleep(20_000)
    }
    if (this.stopping) return
    for (const cmd of prepareCommands(a)) {
      this.console(cmd)
      await sleep(250)
    }
    await sleep(5_000)
    for (const side of SIDES) {
      const base = a.bases[side]
      const chest = chestOf(base)
      await this.order(
        side,
        `war reset ${this.state.series} ${this.state.round} ${base.home.x} ${base.home.y} ${base.home.z} ${chest.x} ${chest.y} ${chest.z}`
      )
    }
    const round: RoundFile = {
      series: this.state.series,
      round: this.state.round,
      startedAt: Date.now(),
    }
    writeJson(this.roundFile(), round)
    this.phase('build')
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
    round.stockAtOrder = Object.fromEntries(SIDES.map((s) => [s, this.stock(s)]))
    writeJson(this.roundFile(), round)
    await Promise.all(
      SIDES.map((side) => {
        const enemy = SIDES.find((s) => s !== side)!
        const base = a.bases[enemy]
        const chest = chestOf(base)
        return this.order(
          side,
          `war raid ${chest.x} ${chest.y} ${chest.z} ${base.home.x} ${base.home.y} ${base.home.z}`
        )
      })
    )
    this.phase('raid')
  }

  private async endRaid(): Promise<void> {
    await Promise.all(SIDES.map((side) => this.order(side, 'war end')))
    // Their files settle.
    await sleep(15_000)
    this.phase('score')
  }

  /** The score, each side's lessons, and after the last round of a series the report. */
  private async score(): Promise<void> {
    const a = this.arena
    const states = SIDES.map((s) => this.war(s)).filter((s): s is WarState => s !== undefined)
    if (states.length < SIDES.length) {
      this.log.warn('a side has no war file; the round cannot be scored yet')
      await sleep(30_000)
      return
    }
    const result = score(states, a.sides)
    this.log.info(
      `round ${this.state.round} of series ${this.state.series}: ` +
        (result.winner ? `${result.winner} won by ${result.decidedBy}` : 'a tie') +
        ` (${result.why})`
    )
    const round = readJson<RoundFile>(this.roundFile()) ?? {
      series: this.state.series,
      round: this.state.round,
      startedAt: this.state.phaseAt,
    }
    round.endedAt = Date.now()
    round.score = result
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
          playbook: before,
        },
        this.log,
        { model: WAR_MODEL }
      )
      round.lessons[state.side] = lessons
      playbook.learn(
        {
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

  /** The season so far as one table (season.md), for a look at the curve. */
  private writeTable(): void {
    const rows = this.state.results.map((r) => {
      const by = (side: string) => r.score.sides.find((s) => s.side === side)
      const cells = SIDES.flatMap((s): string[] => {
        const x = by(s)
        return x
          ? [x.brought, x.lost, x.kills, x.deaths, x.trips].map(String)
          : ['', '', '', '', '']
      })
      return `| ${r.series} | ${r.round} | ${r.score.winner ?? 'tie'} | ${r.score.decidedBy} | ${cells.join(' | ')} |`
    })
    const head = SIDES.map(
      (s) => `${s} brought | ${s} lost | ${s} kills | ${s} deaths | ${s} trips`
    ).join(' | ')
    const text = [
      '# The war game, so far',
      '',
      `| series | round | winner | by | ${head} |`,
      `|---|---|---|---|${SIDES.map(() => '---|---|---|---|---').join('|')}|`,
      ...rows,
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
    for (const side of SIDES) lessons[side] = rounds.flatMap((r) => r.lessons[side] ?? [])
    const before = [
      ...new Set(this.state.results.filter((r) => r.series < series).map((r) => r.series)),
    ].map((s) => {
      const won = (side: string) =>
        this.state.results.filter((r) => r.series === s && r.score.winner === side).length
      return `series ${s}: ${SIDES.map((side) => `${side} won ${won(side)}`).join(', ')}`
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
