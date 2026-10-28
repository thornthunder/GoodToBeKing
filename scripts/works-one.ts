/**
 * Joins one bot and builds a single section of a castle design, for trying the mason out.
 *
 *   tsx scripts/works-one.ts <design.json> <section id> [bot name]
 */
import fs from 'node:fs'
import { serverOptions } from '../src/bot/Bot'
import { createBot } from 'mineflayer-bedrock'
import { compileDesign } from '../src/build/compile'
import type { CastleDesign } from '../src/build/design'
import { Mason } from '../src/build/Mason'
import { defaultBotConfig } from '../src/config'
import { createLogger, setLogLevel } from '../src/logger'

const [file, sectionId, name = 'Henry'] = process.argv.slice(2)
const plan = compileDesign(JSON.parse(fs.readFileSync(file, 'utf8')) as CastleDesign)
const section = plan.sections.find((s) => s.id === sectionId)
if (!section) throw new Error(`no section ${sectionId}; try one of: ${plan.sections.map((s) => s.id).join(', ')}`)
setLogLevel((process.env.LOG_LEVEL as 'debug') ?? 'info')
const log = createLogger(name)
const cfg = defaultBotConfig()
const body = createBot({ ...serverOptions(cfg.server), username: name, auth: 'offline', hideErrors: true })
body.on('error', (e) => log.debug(`body error: ${e.message}`))
body.once('spawn', async () => {
  await body.waitForChunksToLoad()
  await new Promise((r) => setTimeout(r, 2000))
  log.info(`spawned at ${body.entity.position}; building ${section.title}`)
  const mason = new Mason(body, log.child('mason'))
  const started = Date.now()
  const result = await mason.work({ id: section.id, title: section.title, cells: section.cells, columns: section.columns, planned: plan.planned })
  log.info(`done in ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(result)}`)
  body.quit('done')
  setTimeout(() => process.exit(0), 1500)
})
process.on('SIGINT', () => {
  body.quit('interrupted')
  setTimeout(() => process.exit(1), 1000)
})
