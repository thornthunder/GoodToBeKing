import type { Bot as MineflayerBot, Furnace } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import type { Gatherer } from './gathering'

/** Raw meat, and what it becomes in the furnace. */
export const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
/** Fuel the court has plenty of: planks first, then logs (coal is kept for torches). */
const FUEL = [/_planks$/, /_log$/]
/** Items one piece of fuel smelts (planks and logs: one and a half). */
const SMELTS_PER_FUEL = 1.5
/** A furnace cooks one item in ten seconds. */
const COOK_MS = 10_000
/** At most this much meat at a time (a wait of a minute and a half). */
const BATCH = 8

type CookBot = MineflayerBot & { pathfinder: Pathfinder }

/**
 * Cooks the storehouse's raw meat in the hall's furnace, with wood for fuel, and puts the cooked
 * food back. Raw chicken is never eaten, and cooked meat fills twice as much.
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

  /** Returns how many it cooked. */
  async cook(furnace: Vec3, storehouse: { x: number; y: number; z: number }): Promise<number> {
    // Meat and fuel out of the storehouse.
    await this.gatherer.withChest(storehouse, async (chest) => {
      let meat = BATCH - this.count(RAW)
      for (const item of chest.containerItems().filter((i) => RAW.test(i.name))) {
        if (meat <= 0) break
        const n = Math.min(meat, item.count)
        await withTimeout(chest.withdraw(item.type, item.metadata, n), 5_000)
        meat -= n
      }
      let fuel = Math.ceil(Math.min(BATCH, this.count(RAW)) / SMELTS_PER_FUEL)
      for (const kind of FUEL) {
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
    const raw = this.bot.inventory.items().filter((i) => RAW.test(i.name))
    if (raw.length === 0) return 0
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
    let cooked = 0
    try {
      const fuel = this.bot.inventory.items().find((i) => FUEL.some((f) => f.test(i.name)))
      const meat = raw[0]
      const n = Math.min(BATCH, meat.count)
      if (fuel)
        await window.putFuel(
          fuel.type,
          fuel.metadata,
          Math.min(fuel.count, Math.ceil(n / SMELTS_PER_FUEL))
        )
      await window.putInput(meat.type, meat.metadata, n)
      this.log.info(`cooking ${n} ${meat.name}`)
      const done = Date.now() + n * COOK_MS + 8_000
      while (Date.now() < done && (window.outputItem()?.count ?? 0) < n) await sleep(1_000)
      if (window.outputItem()) {
        cooked = window.outputItem()?.count ?? 0
        await window.takeOutput()
      }
      // Whatever did not cook comes back out with us.
      if (window.inputItem()) await window.takeInput().catch(() => {})
    } catch (err) {
      this.log.info(`cooking went wrong: ${errMsg(err)}`)
    } finally {
      window.close()
    }
    // Cooked food and leftover wood back into the storehouse.
    await this.gatherer.withChest(storehouse, async (chest) => {
      for (const item of this.bot.inventory.items()) {
        if (/^cooked_|_planks$|_log$/.test(item.name) || RAW.test(item.name))
          await withTimeout(chest.deposit(item.type, item.metadata, item.count), 5_000)
      }
      return 0
    })
    this.log.info(`cooked ${cooked}`)
    return cooked
  }
}
