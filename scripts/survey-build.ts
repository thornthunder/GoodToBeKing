/**
 * Joins as a silent surveyor and compares a blueprint at a given corner with what stands in the
 * world, listing missing or different blocks, then maps the ground under and around it: for each
 * column, how far below the floor the first solid block is (0 = solid right under the floor).
 *
 *   tsx scripts/survey-build.ts <blueprint> <x> <y> <z> [turns]
 */
import { serverOptions } from '../src/bot/Bot'
import { createBot } from 'mineflayer-bedrock'
import { Vec3 } from 'vec3'
import { BLUEPRINT_IDS, makeBlueprint, rotate, type BlueprintId } from '../src/build/blueprints'
import { defaultBotConfig } from '../src/config'

const [id, x, y, z, turns = '0'] = process.argv.slice(2)
if (!BLUEPRINT_IDS.includes(id as BlueprintId))
  throw new Error(`usage: <${BLUEPRINT_IDS.join('|')}> x y z [turns]`)
const origin = { x: Number(x), y: Number(y), z: Number(z) }
const bp = rotate(makeBlueprint(id as BlueprintId), Number(turns))
const cfg = defaultBotConfig()

const bot = createBot({
  ...serverOptions(cfg.server),
  username: 'Surveyor',
  auth: 'offline',
  hideErrors: true,
})
bot.once('spawn', async () => {
  await bot.waitForChunksToLoad()
  // Make sure the area is loaded: it is within view distance of the spawn point used here.
  const wrong: string[] = []
  const counts: Record<string, number> = {}
  for (const c of bp.cells) {
    const p = new Vec3(origin.x + c.x, origin.y + c.y, origin.z + c.z)
    const found = bot.blockAt(p)?.name ?? 'unloaded'
    if (found !== c.block) {
      wrong.push(`${p.x},${p.y},${p.z}: want ${c.block}, found ${found}`)
      counts[found] = (counts[found] ?? 0) + 1
    }
  }
  console.log(
    `${bp.title} at ${origin.x},${origin.y},${origin.z}: ${bp.cells.length - wrong.length}/${bp.cells.length} blocks as designed`
  )
  if (wrong.length) {
    console.log('found instead:', JSON.stringify(counts))
    for (const w of wrong.slice(0, 40)) console.log(`  ${w}`)
  }
  const AIRY = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|water|flowing_water)$/
  console.log(`ground depth under floor y=${origin.y} (. = solid at y-1, digit = air gap, + = 9 or more)`)
  for (let dz = -2; dz < bp.size.z + 2; dz++) {
    let row = ''
    for (let dx = -2; dx < bp.size.x + 2; dx++) {
      let depth = 0
      while (depth < 9) {
        const name = bot.blockAt(new Vec3(origin.x + dx, origin.y - 1 - depth, origin.z + dz))?.name
        if (name === undefined || !AIRY.test(name)) break
        depth++
      }
      row += depth === 0 ? '.' : depth >= 9 ? '+' : String(depth)
    }
    console.log(`  z=${String(origin.z + dz).padStart(4)} ${row}`)
  }
  console.log(`  x from ${origin.x - 2} to ${origin.x + bp.size.x + 1}`)
  bot.quit('survey done')
  setTimeout(() => process.exit(0), 1000)
})
bot.on('error', (e) => console.log('error', e.message))
setTimeout(() => {
  console.log('timed out')
  process.exit(2)
}, 60_000)
