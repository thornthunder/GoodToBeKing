/**
 * Lets the overlord plan a castle from a terrain survey (see survey-terrain.ts json=...),
 * without any bot in the world, and writes the design it settles on.
 *
 *   tsx scripts/overlord-plan.ts <terrain.json> <out.json> [model]
 */
import fs from 'node:fs'
import { Overlord } from '../src/ai/Overlord'
import { OllamaClient } from '../src/ai/OllamaClient'
import { compileDesign } from '../src/build/compile'
import type { CastleDesign } from '../src/build/design'
import { findCastleSites } from '../src/build/sites'
import { defaultBotConfig } from '../src/config'
import { createLogger, setLogLevel } from '../src/logger'

const [terrainFile, outFile, model = 'gemma4:26b'] = process.argv.slice(2)
setLogLevel('info')
const log = createLogger('overlord')
const cfg = defaultBotConfig()
const columns = JSON.parse(fs.readFileSync(terrainFile, 'utf8')) as Array<{
  x: number
  z: number
  y: number | null
  block: string | null
}>
const map = new Map(columns.map((c) => [`${c.x},${c.z}`, c]))
const topAt = (x: number, z: number) => {
  const c = map.get(`${x},${z}`)
  return c && c.y !== null && c.block ? { y: c.y, name: c.block } : null
}
const great = JSON.parse(
  fs.readFileSync('config/castles/great-castle.json', 'utf8')
) as CastleDesign
const zone = cfg.buildZone ?? { center: { x: 105, y: 75, z: 122 }, radius: 100 }
const sites = findCastleSites(topAt, zone, { avoid: [great.area] })
for (const [i, s] of sites.entries()) log.info(`site ${i + 1}: ${JSON.stringify(s)}`)
const ai = new OllamaClient(
  { ...cfg.ai, timeoutMs: 20 * 60_000, numCtx: 32_768, keepAlive: '2m' },
  log.child('ollama')
)
const overlord = new Overlord(ai, model, log)
void main()

async function main(): Promise<void> {
  const started = Date.now()
  const result = await overlord.planCastle({
    sites,
    crew: [
      { name: 'Merlin', role: 'court wizard' },
      { name: 'Festaris', role: 'Castellan' },
      { name: 'Bruce', role: 'royal guard' },
      { name: 'Dyke', role: 'royal guard' },
      { name: 'Henry', role: 'apprentice to the Castellan' },
      { name: 'George', role: 'apprentice to the Castellan' },
    ],
    example: great,
    takenNames: [great.name],
  })
  log.info(`took ${Math.round((Date.now() - started) / 1000)}s`)
  if (!result) process.exit(1)
  fs.writeFileSync(outFile, JSON.stringify(result.design, null, 2))
  const plan = compileDesign(result.design)
  log.info(
    `${result.design.name}: ${plan.sections.length} sections, ${plan.sections.reduce((n, s) => n + s.cells.length, 0)} blocks; summary: ${result.summary}`
  )
  // The HTTP client keeps the process alive otherwise.
  process.exit(0)
}
