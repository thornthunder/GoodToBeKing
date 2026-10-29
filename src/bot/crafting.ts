import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'

type Block = NonNullable<ReturnType<MineflayerBot['blockAt']>>

const ROOM =
  /^(air|short_grass|tall_grass|fern|large_fern|snow_layer|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip)$/

/** Planks from the logs carried, four from each (enough for `want`). */
export async function makePlanks(bot: MineflayerBot, log: Logger, want: number): Promise<void> {
  for (const item of bot.inventory.items().filter((i) => /_log$/.test(i.name))) {
    if (want <= 0) return
    const plank = bot.registry.itemsByName[item.name.replace(/_log$/, '_planks')]
    const recipe = plank && bot.recipesFor(plank.id, null, 1, null)[0]
    if (!recipe) continue
    const times = Math.min(item.count, Math.ceil(want / 4))
    try {
      await withTimeout(bot.craft(recipe, times, undefined), 15_000)
      want -= times * 4
    } catch (err) {
      log.info(`could not make planks from ${item.name}: ${errMsg(err)}`)
    }
  }
}

const planks = (bot: MineflayerBot) =>
  bot.inventory
    .items()
    .filter((i) => /_planks$/.test(i.name))
    .reduce((n, i) => n + i.count, 0)

/**
 * Craft `times` of an item: in the small grid when it fits, else at a crafting table close by,
 * else at one put down for the purpose and taken back up afterwards.
 */
export async function craft(
  bot: MineflayerBot,
  log: Logger,
  name: string,
  times: number
): Promise<boolean> {
  const item = bot.registry.itemsByName[name]
  if (!item) return false
  const small = bot.recipesFor(item.id, null, 1, null)[0]
  if (small) return run(bot, log, name, small, times)
  const near = bot.findBlocks({
    matching: (b: { name: string }) => b.name === 'crafting_table',
    maxDistance: 4,
    count: 1,
  })[0]
  const nearTable = near && bot.blockAt(near)
  if (nearTable) return withTable(bot, log, name, times, nearTable)
  // Our own table, for the moment.
  if (bot.inventory.items().every((i) => i.name !== 'crafting_table')) {
    if (planks(bot) < 4) await makePlanks(bot, log, 4 - planks(bot))
    const recipe = bot.recipesFor(bot.registry.itemsByName.crafting_table.id, null, 1, null)[0]
    if (!recipe || !(await run(bot, log, 'crafting_table', recipe, 1))) return false
  }
  const placed = await putDownTable(bot, log)
  if (!placed) return false
  try {
    return await withTable(bot, log, name, times, placed)
  } finally {
    await withTimeout(bot.dig(placed, true), 10_000).catch((err) =>
      log.info(`could not take the crafting table back up: ${errMsg(err)}`)
    )
    await sleep(600)
  }
}

async function withTable(
  bot: MineflayerBot,
  log: Logger,
  name: string,
  times: number,
  table: Block
): Promise<boolean> {
  const recipe = bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, table)[0]
  if (!recipe) {
    log.info(`no recipe for ${name} with what I carry`)
    return false
  }
  return run(bot, log, name, recipe, times, table)
}

async function run(
  bot: MineflayerBot,
  log: Logger,
  name: string,
  recipe: Parameters<MineflayerBot['craft']>[0],
  times: number,
  table?: Block
): Promise<boolean> {
  try {
    await withTimeout(bot.craft(recipe, times, table), 15_000)
    return true
  } catch (err) {
    log.info(`could not craft ${name}: ${errMsg(err)}`)
    return false
  }
}

/** Put the carried crafting table down on the floor beside the bot. */
async function putDownTable(bot: MineflayerBot, log: Logger): Promise<Block | undefined> {
  const table = bot.inventory.items().find((i) => i.name === 'crafting_table')
  if (!table) return undefined
  const me = bot.entity.position.floored()
  for (const [dx, dz] of [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [2, 1],
    [-2, -1],
  ]) {
    const spot = new Vec3(me.x + dx, me.y, me.z + dz)
    const floor = bot.blockAt(spot.offset(0, -1, 0))
    const there = bot.blockAt(spot)
    // Grass and flowers make way for a block put down on them.
    if (!floor || floor.boundingBox !== 'block' || !there || !ROOM.test(there.name)) continue
    try {
      await bot.equip(table, 'hand')
      await withTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)), 5_000)
    } catch (err) {
      log.debug(`could not put the crafting table at ${spot}: ${errMsg(err)}`)
      continue
    }
    const placed = bot.blockAt(spot)
    if (placed?.name === 'crafting_table') return placed
  }
  log.info('no room to put a crafting table down')
  return undefined
}
