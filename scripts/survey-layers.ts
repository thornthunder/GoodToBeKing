/**
 * Joins as a silent surveyor and prints a box of blocks layer by layer, top down: one character
 * per block, so holes, walls, roofs and caves show up.
 *
 *   tsx scripts/survey-layers.ts <x1> <z1> <x2> <z2> <y1> <y2>
 */
import { createBot } from 'mineflayer-bedrock'
import { Vec3 } from 'vec3'
import { serverOptions } from '../src/bot/Bot'
import { defaultBotConfig } from '../src/config'

const [x1, z1, x2, z2, y1, y2] = process.argv.slice(2).map(Number)
const LETTER: Array<[RegExp, string]> = [
  [/^(air|cave_air|void_air)$/, '.'],
  [/^grass_block$/, 'g'],
  [/dirt|podzol|mud|farmland/, 'd'],
  [/^cobblestone$/, 'c'],
  [/^(stone|andesite|diorite|granite|deepslate|tuff|calcite)$/, 'r'],
  [/gravel|sand/, 's'],
  [/planks/, 'p'],
  [/_log$/, 'L'],
  [/leaves/, 'T'],
  [/water/, '~'],
  [/lava/, '!'],
  [/torch/, 't'],
  [/door/, 'D'],
  [/bed$/, 'b'],
  [/chest/, 'C'],
  [/furnace/, 'F'],
  [/crafting_table/, 'W'],
  [/ore/, 'o'],
  [/grass|fern|flower|poppy|dandelion|tulip|bush|vine|lichen/, ','],
]
const cfg = defaultBotConfig()
const bot = createBot({
  ...serverOptions(cfg.server),
  username: 'Surveyor',
  auth: 'offline',
  hideErrors: true,
})
bot.once('spawn', async () => {
  await bot.waitForChunksToLoad()
  await new Promise((r) => setTimeout(r, 3000))
  const others: Record<string, number> = {}
  console.log(`columns x ${x1}..${x2} left to right, rows z ${z1}..${z2}`)
  for (let y = Math.max(y1, y2); y >= Math.min(y1, y2); y--) {
    console.log(`y ${y}`)
    for (let z = z1; z <= z2; z++) {
      let row = `  ${String(z).padStart(4)} `
      for (let x = x1; x <= x2; x++) {
        const name = bot.blockAt(new Vec3(x, y, z))?.name
        if (name === undefined) row += '?'
        else {
          const ch = LETTER.find(([re]) => re.test(name))?.[1]
          if (!ch) others[name] = (others[name] ?? 0) + 1
          row += ch ?? 'B'
        }
      }
      console.log(row)
    }
  }
  const mobs = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(new Vec3(x1, y1, z1)) < 64)
    .map((e) => `${e.name ?? e.username ?? e.type} ${e.position.floored()}`)
  console.log('B:', JSON.stringify(others))
  console.log('entities:', mobs.join('; '))
  bot.end()
  setTimeout(() => process.exit(0), 1000)
})
