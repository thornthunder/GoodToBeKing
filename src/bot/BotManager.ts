import path from 'node:path'
import { CourtMemory } from '../ai/CourtMemory'
import { HailLog } from '../ai/HailLog'
import { OllamaBrain } from '../ai/OllamaBrain'
import { OllamaClient } from '../ai/OllamaClient'
import { BuildLog } from '../build/BuildLog'
import { BLUEPRINT_IDS, DEFAULT_PALETTE, type BlueprintId } from '../build/blueprints'
import type { AppConfig } from '../config'
import { CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg, sleep } from '../util'
import { Bot } from './Bot'

/** Runtime state that should survive restarts (git-ignored). */
const STATE_DIR = '.state'

/** Creates and supervises every configured bot. */
export class BotManager {
  readonly bots: Bot[] = []

  constructor(
    cfg: AppConfig,
    private readonly log: Logger
  ) {
    const court = new CourtRoster(cfg.court)
    const botNames = cfg.bots.map((b) => b.name)
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
      })
      this.bots.push(new Bot(botCfg, brain, botLog, botNames, builds))
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
    } else if (verb === 'undo') {
      this.log.info(`command: ${bot.cfg.name} takes down its last build`)
      void bot.undoLastBuild(requestedBy)
    } else {
      this.log.warn(`unknown command: ${line}`)
    }
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
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.bots.map((bot) => bot.disconnect('Shutting down')))
  }
}
