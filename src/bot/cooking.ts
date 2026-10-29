import type { Bot as MineflayerBot, Furnace } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import type { Gatherer } from './gathering'

/** Raw meat, and what it becomes in the furnace. */
export const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
/** Logs become charcoal: fuel, and torches with a stick. */
const LOGS = /_log$/
/** Ores the furnace turns into ingots. */
export const ORES = /^(raw_iron|raw_gold|raw_copper|iron_ore|gold_ore|copper_ore)$/
/** Fuel the court has plenty of: planks first, then logs (coal is kept for torches). */
const FUEL = [/_planks$/, /_log$/]
/** Items one piece of fuel smelts (planks and logs: one and a half). */
const SMELTS_PER_FUEL = 1.5
/** A furnace smelts one item in ten seconds. */
const SMELT_MS = 10_000
/** At most this much at a time (a wait of a minute and a half). */
const BATCH = 8
/** What comes back to the storehouse afterwards: the furnace's work, and what was left over. */
const AFTER = /^cooked_|^charcoal$|_ingot$|_planks$|_log$|^raw_/

type CookBot = MineflayerBot & { pathfinder: Pathfinder }

/**
 * The court's furnace work: cooking raw meat (raw chicken is never eaten, and cooked meat fills
 * twice as much), charcoal from logs (fuel, and torches without any coal), ingots from ore. Fuel
 * is the court's own wood; the work goes back into the storehouse.
 */
export class Cook {
  private readonly bot: CookBot

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly gatherer: Gatherer
  ) {
    this.bot = bot as CookBot
  }

  private count(items: RegExp): number {
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  /** Cook the storehouse's raw meat. Returns how much it cooked. */
  cook(furnace: Vec3, storehouse: { x: number; y: number; z: number }): Promise<number> {
    return this.smelt(furnace, storehouse, RAW, FUEL)
  }

  /** Charcoal from the storehouse's logs, with planks for fuel. Returns how much it made. */
  charcoal(furnace: Vec3, storehouse: { x: number; y: number; z: number }): Promise<number> {
    return this.smelt(furnace, storehouse, LOGS, [/_planks$/])
  }

  /** Ingots from the storehouse's ore. */
  ingots(furnace: Vec3, storehouse: { x: number; y: number; z: number }): Promise<number> {
    return this.smelt(furnace, storehouse, ORES, FUEL)
  }

  /** Take up to a batch of `input` and fuel from the storehouse, smelt it, put the work back. */
  async smelt(
    furnace: Vec3,
    storehouse: { x: number; y: number; z: number },
    input: RegExp,
    fuels: RegExp[]
  ): Promise<number> {
    await this.gatherer.withChest(storehouse, async (chest) => {
      let want = BATCH - this.count(input)
      for (const item of chest.containerItems().filter((i) => input.test(i.name))) {
        if (want <= 0) break
        const n = Math.min(want, item.count)
        await withTimeout(chest.withdraw(item.type, item.metadata, n), 5_000)
        want -= n
      }
      let fuel = Math.ceil(Math.min(BATCH, this.count(input)) / SMELTS_PER_FUEL)
      for (const kind of fuels) {
        fuel -= this.count(kind)
        for (const item of chest.containerItems().filter((i) => kind.test(i.name))) {
          if (fuel <= 0) break
          const n = Math.min(fuel, item.count)
          await withTimeout(chest.withdraw(item.type, item.metadata, n), 5_000)
          fuel -= n
        }
      }
      return 0
    })
    const stuff = this.bot.inventory.items().find((i) => input.test(i.name))
    if (!stuff) return 0
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(furnace.x, furnace.y, furnace.z, 2)),
        30_000
      )
    } catch (err) {
      this.bot.pathfinder.setGoal(null)
      this.log.info(`could not get to the furnace: ${errMsg(err)}`)
      return 0
    }
    const block = this.bot.blockAt(furnace)
    if (!block || !/furnace$/.test(block.name)) return 0
    let window: Furnace
    try {
      window = await withTimeout(this.bot.openFurnace(block), 8_000)
    } catch (err) {
      this.log.info(`could not open the furnace: ${errMsg(err)}`)
      return 0
    }
    let made = 0
    try {
      const fuel = this.bot.inventory
        .items()
        .find((i) => fuels.some((f) => f.test(i.name)) && i !== stuff)
      const n = Math.min(BATCH, stuff.count)
      if (fuel)
        await window.putFuel(
          fuel.type,
          fuel.metadata,
          Math.min(fuel.count, Math.ceil(n / SMELTS_PER_FUEL))
        )
      await window.putInput(stuff.type, stuff.metadata, n)
      this.log.info(`smelting ${n} ${stuff.name}`)
      const done = Date.now() + n * SMELT_MS + 8_000
      while (Date.now() < done && (window.outputItem()?.count ?? 0) < n) await sleep(1_000)
      if (window.outputItem()) {
        made = window.outputItem()?.count ?? 0
        await window.takeOutput()
      }
      // Whatever did not smelt comes back out with us.
      if (window.inputItem()) await window.takeInput().catch(() => {})
    } catch (err) {
      this.log.info(`the furnace work went wrong: ${errMsg(err)}`)
    } finally {
      window.close()
    }
    await this.gatherer.withChest(storehouse, async (chest) => {
      for (const item of this.bot.inventory.items()) {
        if (AFTER.test(item.name) || RAW.test(item.name) || ORES.test(item.name))
          await withTimeout(chest.deposit(item.type, item.metadata, item.count), 5_000)
      }
      return 0
    })
    this.log.info(`smelted ${made}`)
    return made
  }
}
