/**
 * Joins as a silent surveyor and prints a height map of an area: one character per column, the
 * height of the top solid block in base 36 relative to a base height (0-9, a-z), or a marker for
 * water (~), lava (!), trees (T), our own building blocks (#) and unloaded columns (?).
 *
 *   tsx scripts/survey-terrain.ts <x1> <z1> <x2> <z2> [baseY]
 */
import fs from 'node:fs'
import { createBot } from 'mineflayer-bedrock'
import { Vec3 } from 'vec3'
import { defaultBotConfig } from '../src/config'

const [x1, z1, x2, z2, base = 60] = process.argv.slice(2).map(Number)
/** With "types", print the surface block type instead of its height. */
const types = process.argv.includes('types')
/** With "json=<file>", also write every column's top block and height to a file. */
const jsonFile = process.argv.find((a) => a.startsWith('json='))?.slice(5)
const columns: Array<{ x: number; z: number; y: number | null; block: string | null }> = []
const LETTER: Array<[RegExp, string]> = [
  [/^grass_block$/, 'g'],
  [/^sand$/, 's'],
  [/^(grass_path|dirt_path)$/, 'p'],
  [/dirt|podzol|mud/, 'd'],
  [/^(stone|andesite|diorite|granite|gravel|sandstone|clay|deepslate|tuff|calcite)$/, 'r'],
  [/water/, '~'],
  [/lava/, '!'],
  [/leaves|_log$/, 'T'],
  [/stone_bricks|quartz|lantern/, '#'],
]
const cfg = defaultBotConfig()
const bot = createBot({
  host: cfg.server.host,
  port: cfg.server.port,
  username: 'Surveyor',
  auth: 'offline',
  hideErrors: true,
})
const SKIP = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|.*flower.*|poppy|dandelion|allium|cornflower|azure_bluet|oxeye_daisy|.*tulip|lily_of_the_valley|sweet_berry_bush|snow_layer|deadbush|dead_bush|vine|glow_lichen|sugar_cane|bush|leaf_litter|firefly_bush|wildflowers|short_dry_grass|tall_dry_grass)$/
bot.once('spawn', async () => {
  await bot.waitForChunksToLoad()
  await new Promise((r) => setTimeout(r, 3000))
  const p = bot.entity.position
  console.log(`surveyor spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`)
  const counts: Record<string, number> = {}
  console.log(`height map, base y=${base}; columns x ${x1}..${x2} left to right`)
  for (let z = z1; z <= z2; z++) {
    let row = ''
    for (let x = x1; x <= x2; x++) {
      let ch = '?'
      let top: { y: number; block: string } | null = null
      for (let y = base + 40; y >= base - 10; y--) {
        const name = bot.blockAt(new Vec3(x, y, z))?.name
        if (name === undefined) break
        if (SKIP.test(name)) continue
        counts[name] = (counts[name] ?? 0) + 1
        top = { y, block: name }
        if (types) ch = LETTER.find(([re]) => re.test(name))?.[1] ?? 'B'
        else if (/water/.test(name)) ch = '~'
        else if (/lava/.test(name)) ch = '!'
        else if (/leaves|_log$/.test(name)) ch = 'T'
        else if (/stone_bricks|quartz|lantern/.test(name)) ch = '#'
        else ch = y - base >= 0 && y - base < 36 ? (y - base).toString(36) : y < base ? '_' : '^'
        break
      }
      row += ch
      columns.push({ x, z, y: top?.y ?? null, block: top?.block ?? null })
    }
    console.log(`${String(z).padStart(5)} ${row}`)
  }
  if (types)
    console.log('g grass, s sand, p path, d dirt, r rock, ~ water, T tree, # castle, B other (built)')
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)
  console.log('top surface blocks:', top.map(([n, c]) => `${n} ${c}`).join(', '))
  if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify(columns))
  bot.quit('survey done')
  setTimeout(() => process.exit(0), 1000)
})
bot.on('error', (e) => console.log('error', e.message))
setTimeout(() => {
  console.log('timed out')
  process.exit(2)
}, 90_000)
