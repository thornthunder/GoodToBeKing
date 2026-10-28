import fs from 'node:fs'
import path from 'node:path'
import { OllamaClient } from './ai/OllamaClient'
import { BotManager } from './bot/BotManager'
import { loadConfig } from './config'
import { createLogger, setLogLevel } from './logger'
import { errMsg } from './util'

async function main(): Promise<void> {
  const config = loadConfig()
  setLogLevel(config.logLevel)
  const log = createLogger('app')

  log.info(
    `GoodToBeKing starting ${config.bots.length} bot(s): ${config.bots.map((b) => b.name).join(', ')}`
  )

  const { court } = config
  if (court.file) {
    const roles = court.members.map((m) => `${m.title} ${m.player}`).join(', ')
    log.info(`court of ${court.realm}: ${roles || 'no members'} (${court.file})`)
  } else {
    log.warn('no court roster found (COURT_FILE, default config/court.json); nobody will be hailed')
  }

  // Preflight: make sure the model server is reachable before players start talking to us.
  const first = config.bots[0]
  try {
    const health = await new OllamaClient(first.ai, log.child('ollama')).health()
    log.info(`Ollama ${health.version} at ${first.ai.host}, ${health.models.length} models`)
    if (!health.hasModel) {
      log.warn(
        `model "${first.ai.model}" is not on the server; available: ${health.models.join(', ')}`
      )
    }
  } catch (err) {
    log.warn(`Ollama at ${first.ai.host} is not reachable (${errMsg(err)}); bots will stay quiet`)
  }

  const manager = new BotManager(config, log)

  let shuttingDown = false
  const shutdown = async (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${reason}, disconnecting bots`)
    await manager.stopAll()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT received'))
  process.on('SIGTERM', () => void shutdown('SIGTERM received'))

  // Windows cannot send a background process a polite signal, and a hard kill leaves the bot's
  // session on the server (server_id_conflict on restart). Creating this file stops cleanly.
  const stopFile = path.resolve(STOP_FILE)
  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile)
  setInterval(() => {
    if (!fs.existsSync(stopFile)) return
    fs.unlinkSync(stopFile)
    void shutdown(`${STOP_FILE} found`)
  }, 1_000).unref()

  // Developer commands for the running bots, one per line, e.g. "Merlin build castle 105 75 122".
  const commandFile = path.resolve(COMMAND_FILE)
  if (fs.existsSync(commandFile)) fs.unlinkSync(commandFile)
  setInterval(() => {
    if (!fs.existsSync(commandFile)) return
    const lines = fs
      .readFileSync(commandFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
    fs.unlinkSync(commandFile)
    for (const line of lines) manager.runCommand(line)
  }, 1_000).unref()

  await manager.startAll()
}

const STOP_FILE = process.env.STOP_FILE || '.stop'
/** In Docker this lives in the mounted state folder, so the host can drop commands in. */
const COMMAND_FILE = process.env.COMMAND_FILE || '.command'

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
