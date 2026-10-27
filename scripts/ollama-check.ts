/** Verify the configured Ollama server is reachable and the model answers. */
import { OllamaClient } from '../src/ai/OllamaClient'
import { defaultBotConfig } from '../src/config'
import { createLogger, setLogLevel } from '../src/logger'

async function main(): Promise<void> {
  setLogLevel('debug')
  const log = createLogger('ollama-check')
  const cfg = defaultBotConfig().ai
  const ai = new OllamaClient(cfg, log)

  log.info(`host=${cfg.host} model=${cfg.model}`)
  const health = await ai.health()
  log.info(`server version ${health.version}, ${health.models.length} models:`)
  for (const name of health.models) log.info(`  ${name === cfg.model ? '*' : ' '} ${name}`)
  if (!health.hasModel) {
    log.error(`model "${cfg.model}" is not available on this server`)
    process.exit(2)
  }

  const started = Date.now()
  const res = await ai.chat([
    {
      role: 'system',
      content: 'You are a Minecraft player. Reply in one short plain-text sentence.',
    },
    { role: 'user', content: 'Steve: hey, who are you?' },
  ])
  log.info(`reply in ${Date.now() - started}ms: ${JSON.stringify(res.message.content)}`)
  if (res.message.thinking) log.debug(`thinking: ${res.message.thinking.slice(0, 200)}`)
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
