import fs from 'node:fs'
import path from 'node:path'
import { CourtMemory } from '../ai/CourtMemory'
import { HailLog } from '../ai/HailLog'
import { OllamaBrain } from '../ai/OllamaBrain'
import { OllamaClient } from '../ai/OllamaClient'
import { BuildLog } from '../build/BuildLog'
import { BLUEPRINT_IDS, DEFAULT_PALETTE, type BlueprintId } from '../build/blueprints'
import { compileDesign } from '../build/compile'
import { validateDesign, type CastleDesign } from '../build/design'
import { Works, type Worker, type WorksEvent } from '../build/Works'
import type { AppConfig } from '../config'
import { CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg, sleep } from '../util'
import { Bot } from './Bot'
import { ChatFloor } from './ChatFloor'

/** Runtime state that should survive restarts (git-ignored). */
const STATE_DIR = '.state'

/** At most one exchange of work talk between bots this often. */
const CHATTER_GAP_MS = 40_000
/** No work talk this soon after a royal spoke: their conversation comes first. */
const ROYAL_QUIET_MS = 90_000

/** Creates and supervises every configured bot. */
export class BotManager {
  readonly bots: Bot[] = []
  works?: Works
  private worksTimer?: NodeJS.Timeout
  private lastChatter = 0
  private lastRoyalLine = 0
  private milestone = 0
  /** All bots have had their first go at connecting; the works may begin. */
  private ready = false

  constructor(
    cfg: AppConfig,
    private readonly log: Logger
  ) {
    const court = new CourtRoster(cfg.court)
    const botNames = cfg.bots.map((b) => b.name)
    // Who speaks: bots in configured order for the royals; the Castellan first for guests.
    const castellanFirst = [...botNames].sort(
      (a, b) => Number(isCastellan(cfg, b)) - Number(isCastellan(cfg, a))
    )
    const floor = new ChatFloor(botNames, castellanFirst)
    const staff = cfg.bots.map((b) => ({ name: b.name, role: b.role, canBuild: b.canBuild }))
    // One memory for the whole court, so every bot knows what the princess told any of them.
    const memory = new CourtMemory(path.resolve(STATE_DIR, 'memory.json'))
    // What each bot built, so "take it down" removes only that bot's own blocks.
    const builds = new BuildLog(path.resolve(STATE_DIR, 'builds.json'))
    for (const [i, botCfg] of cfg.bots.entries()) {
      const botLog = log.child(botCfg.name)
      const ai = new OllamaClient(botCfg.ai, botLog.child('ollama'))
      const hails = new HailLog(path.resolve(STATE_DIR, `${botCfg.name}.hails.json`))
      const brain = new OllamaBrain(botCfg, ai, court, botLog.child('brain'), {
        hails,
        memory,
        // The first bot is the court's scribe; several scribes would store every fact twice.
        learns: i === 0,
        staff,
      })
      const bot = new Bot(botCfg, brain, botLog, {
        fellowBots: botNames,
        buildLog: builds,
        floor,
        court,
        works: () => this.works?.summary(),
      })
      bot.on('chat', (event: { from: string }) => {
        if (court.find(event.from)) this.lastRoyalLine = Date.now()
      })
      this.bots.push(bot)
    }
    if (cfg.worksDesign) this.startWorks(cfg.worksDesign)
  }

  /** Begin (or carry on with) building a castle design with every bot that works. */
  startWorks(file: string): boolean {
    let design: CastleDesign
    try {
      design = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as CastleDesign
    } catch (err) {
      this.log.warn(`cannot read castle design ${file}: ${errMsg(err)}`)
      return false
    }
    const problems = validateDesign(design)
    if (problems.length) {
      this.log.warn(`castle design ${file} has problems:\n  ${problems.join('\n  ')}`)
      return false
    }
    const plan = compileDesign(design)
    clearInterval(this.worksTimer)
    this.milestone = 0
    this.works = new Works(
      plan,
      path.resolve(STATE_DIR, `works-${plan.id}.json`),
      this.log.child('works'),
      (e) => this.onWorksEvent(e)
    )
    const blocks = plan.sections.reduce((n, s) => n + s.cells.length, 0)
    const { done, total } = this.works.progress()
    this.log.info(`works: ${plan.title}, ${total} sections (${done} done), ${blocks} blocks`)
    if (this.ready) this.runWorks()
    return true
  }

  private runWorks(): void {
    clearInterval(this.worksTimer)
    this.worksTimer = setInterval(() => this.works?.tick(this.workers()), 5_000)
  }

  private workers(): Worker[] {
    return this.bots
      .filter((b) => b.cfg.works)
      .map((b) => ({
        name: b.cfg.name,
        available: () => b.canWork(),
        position: () => b.position(),
        work: (job) => b.work(job),
      }))
  }

  /** The Castellan, if he is in the world: he runs the works and does the talking. */
  private foreman(): Bot | undefined {
    return this.bots.find((b) => /castellan/i.test(b.cfg.role) && b.state.status === 'spawned')
  }

  /** Run some work talk unless the court talked a moment ago or a royal is talking. */
  private chatter(talk: () => Promise<void>, force = false): void {
    const now = Date.now()
    const recent = now - this.lastChatter < CHATTER_GAP_MS || now - this.lastRoyalLine < ROYAL_QUIET_MS
    if (!force && recent) return
    this.lastChatter = now
    talk().catch((err) => this.log.warn(`work talk failed: ${errMsg(err)}`))
  }

  private onWorksEvent(e: WorksEvent): void {
    const foreman = this.foreman()
    const boss = foreman?.cfg.name
    const title = this.works?.plan.title ?? 'the castle'
    switch (e.kind) {
      case 'begin':
        this.chatter(async () => {
          await (foreman ?? this.bots[0])?.speak(
            `Announce to everyone that the court now begins building ${e.plan.title} around Merlin's first castle, as the King wished: ` +
              'a keep with a kitchen, a great hall, a throne room and royal bedchambers, ranges for the guards and staff, stables and towers. ' +
              'Call every member of the court to lend a hand.',
            `Hear me, all! By the King's wish we begin ${e.plan.title} today. Every hand to the work!`
          )
        }, true)
        return
      case 'assign': {
        const worker = this.find(e.worker)
        this.chatter(async () => {
          if (foreman && worker && foreman !== worker) {
            await foreman.speak(
              `Tell ${e.worker} to build ${e.section.title} now. Address ${e.worker} by name.`,
              `${e.worker}, see to ${e.section.title}, if you please.`
            )
            await sleep(3_000)
            await worker.speak(
              `${boss}, the Castellan, just asked you to build ${e.section.title}. Answer ${boss} in one short sentence that you will.`,
              `At once, Master ${boss}!`
            )
          } else if (worker) {
            await worker.speak(
              `Tell the court in one short sentence that you are now building ${e.section.title} yourself.`,
              `I shall see to ${e.section.title} myself.`
            )
          }
        })
        return
      }
      case 'done': {
        if (!e.complete) return
        const worker = this.find(e.worker)
        const { done, total } = this.works?.progress() ?? { done: 0, total: 1 }
        const quarter = Math.floor((done / total) * 4)
        if (quarter > this.milestone && quarter < 4) {
          this.milestone = quarter
          const amount = ['', 'a quarter', 'half', 'three quarters'][quarter]
          this.chatter(async () => {
            await (foreman ?? worker)?.speak(
              `Tell everyone that ${title} is ${amount} done, and encourage the crew.`,
              `${title} is ${amount} done. Well worked, all!`
            )
          }, true)
          return
        }
        this.chatter(async () => {
          await worker?.speak(
            `Tell ${boss ?? 'the court'} in one short sentence that you have finished ${e.section.title}.`,
            `${e.section.title} is finished!`
          )
          if (foreman && worker && foreman !== worker && Math.random() < 0.5) {
            await sleep(3_000)
            await foreman.speak(
              `${e.worker} just finished ${e.section.title}. Thank ${e.worker} warmly in one short sentence.`,
              `Well done, ${e.worker}!`
            )
          }
        })
        return
      }
      case 'finished':
        this.chatter(async () => {
          await (foreman ?? this.bots[0])?.speak(
            `Announce proudly to everyone that ${e.plan.title} is finished, and invite the King and the Princess to come and see it.`,
            `${e.plan.title} is finished! Your Majesty, Your Highness, come and see!`
          )
        }, true)
        return
    }
  }

  find(name: string): Bot | undefined {
    return this.bots.find((b) => b.cfg.name.toLowerCase() === name.toLowerCase())
  }

  /**
   * Developer commands, one per line (see the `.command` file in CLAUDE.md):
   *   <bot> build <blueprint> <x> <y> <z> [for <player>]
   *   <bot> undo [for <player>]
   */
  runCommand(line: string): void {
    const words = line.trim().split(/\s+/)
    const [name, verb] = words
    if (name?.toLowerCase() === 'works') return this.worksCommand(words.slice(1))
    const bot = name ? this.find(name) : undefined
    if (!bot) return this.log.warn(`command for unknown bot: ${line}`)
    const forIndex = words.indexOf('for')
    const requestedBy = forIndex > 0 ? words[forIndex + 1] : 'the court'
    if (verb === 'build') {
      const id = words[2] as BlueprintId
      const [x, y, z] = words.slice(3, 6).map(Number)
      if (!BLUEPRINT_IDS.includes(id) || [x, y, z].some((n) => !Number.isFinite(n))) {
        return this.log.warn(
          `usage: <bot> build <${BLUEPRINT_IDS.join('|')}> <x> <y> <z> [for <player>]`
        )
      }
      this.log.info(`command: ${bot.cfg.name} builds ${id} at ${x},${y},${z} for ${requestedBy}`)
      void bot.startBuild(id, DEFAULT_PALETTE, requestedBy, { x, y, z })
    } else if (verb === 'resume') {
      // <bot> resume <blueprint> <origin x> <y> <z> [turns <0-3>] [for <player>]
      const id = words[2] as BlueprintId
      const [x, y, z] = words.slice(3, 6).map(Number)
      const turnsIndex = words.indexOf('turns')
      const turns = turnsIndex > 0 ? Number(words[turnsIndex + 1]) : 0
      if (!BLUEPRINT_IDS.includes(id) || [x, y, z, turns].some((n) => !Number.isFinite(n))) {
        return this.log.warn(`usage: <bot> resume <blueprint> <x> <y> <z> [turns N] [for <player>]`)
      }
      this.log.info(`command: ${bot.cfg.name} resumes ${id} at ${x},${y},${z} (turns ${turns})`)
      void bot.resumeBuildAt(id, { x, y, z }, turns, requestedBy)
    } else if (verb === 'undo') {
      this.log.info(`command: ${bot.cfg.name} takes down its last build`)
      void bot.undoLastBuild(requestedBy)
    } else {
      this.log.warn(`unknown command: ${line}`)
    }
  }

  /** works status | works pause | works resume | works start <design file> */
  private worksCommand(args: string[]): void {
    const [verb, file] = args
    if (verb === 'start' && file) {
      this.startWorks(file)
      return
    }
    const works = this.works
    if (!works) return this.log.warn('no works in progress')
    if (verb === 'pause') works.paused = true
    else if (verb === 'resume') works.paused = false
    const { done, total, doing } = works.progress()
    this.log.info(
      `works: ${works.plan.title} ${done}/${total}${works.paused ? ' (paused)' : ''}; ` +
        (doing.map((d) => `${d.worker}: ${d.title}`).join('; ') || 'nobody working')
    )
  }

  /** Connect bots one after another; a failure does not stop the others (auto-reconnect takes over). */
  async startAll(staggerMs = 2_000): Promise<void> {
    for (const [i, bot] of this.bots.entries()) {
      if (i > 0) await sleep(staggerMs)
      try {
        await bot.connect()
      } catch (err) {
        this.log.warn(`${bot.cfg.name} failed to connect: ${errMsg(err)}`)
      }
    }
    this.ready = true
    if (this.works) this.runWorks()
  }

  async stopAll(): Promise<void> {
    clearInterval(this.worksTimer)
    await Promise.all(this.bots.map((bot) => bot.disconnect('Shutting down')))
  }
}

function isCastellan(cfg: AppConfig, name: string): boolean {
  return /castellan/i.test(cfg.bots.find((b) => b.name === name)?.role ?? '')
}
