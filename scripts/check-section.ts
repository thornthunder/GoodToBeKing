/**
 * Joins as a silent surveyor and lists the cells of castle sections that are not as planned.
 *
 *   tsx scripts/check-section.ts <design.json> [section id prefix ...]
 */
import fs from 'node:fs'
import { serverOptions } from '../src/bot/Bot'
import { createBot } from 'mineflayer-bedrock'
import { Vec3 } from 'vec3'
import { compileDesign } from '../src/build/compile'
import type { CastleDesign } from '../src/build/design'
import { defaultBotConfig } from '../src/config'

const [file, ...prefixes] = process.argv.slice(2)
const plan = compileDesign(JSON.parse(fs.readFileSync(file, 'utf8')) as CastleDesign)
const sections = plan.sections.filter((s) => !prefixes.length || prefixes.some((p) => s.id.startsWith(p)))
const cfg = defaultBotConfig()
const bot = createBot({ ...serverOptions(cfg.server), username: 'Surveyor', auth: 'offline', hideErrors: true })
bot.once('spawn', async () => {
  await bot.waitForChunksToLoad()
  await new Promise((r) => setTimeout(r, 3000))
  for (const s of sections) {
    const wrong: string[] = []
    for (const c of s.cells) {
      const found = bot.blockAt(new Vec3(c.x, c.y, c.z))?.name ?? 'unloaded'
      const ok = c.block === 'air' ? /air/.test(found) : found === c.block
      if (!ok) wrong.push(`${c.x},${c.y},${c.z} want ${c.block} found ${found}`)
    }
    console.log(`${s.id}: ${s.cells.length - wrong.length}/${s.cells.length} as planned`)
    for (const w of wrong.slice(0, 25)) console.log(`  ${w}`)
  }
  bot.quit('done')
  setTimeout(() => process.exit(0), 1000)
})
setTimeout(() => process.exit(2), 60_000)
