import path from 'node:path'
import { CourtMemory } from '../ai/CourtMemory'
import { HailLog } from '../ai/HailLog'
import { OllamaBrain } from '../ai/OllamaBrain'
import { OllamaClient } from '../ai/OllamaClient'
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
      this.bots.push(new Bot(botCfg, brain, botLog, botNames))
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
