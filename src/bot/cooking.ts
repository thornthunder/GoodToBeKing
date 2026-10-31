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

/** A furnace near home: the court's own (in its hall: what is in it is the court's), or not. */
export interface FurnaceSpot {
  at: Vec3
  own: boolean
}

/** Furnaces that failed lately (out of reach, or someone's in use): key -> until when. */
const shunned = new Map<string, number>()
const UNREACHABLE_MS = 30 * 60_000
const IN_USE_MS = 5 * 60_000
const spotKey = (p: Vec3) => `${p.x},${p.y},${p.z}`

/** Furnaces worth trying now (not shunned lately), in the order given. */
export function usableFurnaces(spots: FurnaceSpot[], now = Date.now()): FurnaceSpot[] {
  return spots.filter((s) => (shunned.get(spotKey(s.at)) ?? 0) <= now)
}

function shun(p: Vec3, ms: number): void {
  shunned.set(spotKey(p), Date.now() + ms)
}

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
  cook(furnaces: FurnaceSpot[], storehouse: { x: number; y: number; z: number }): Promise<number> {
    return this.smelt(furnaces, storehouse, RAW, FUEL)
  }

  /** Charcoal from the storehouse's logs, with planks for fuel. Returns how much it made. */
  charcoal(
    furnaces: FurnaceSpot[],
    storehouse: { x: number; y: number; z: number }
  ): Promise<number> {
    return this.smelt(furnaces, storehouse, LOGS, [/_planks$/])
  }

  /** Ingots from the storehouse's ore. */
  ingots(furnaces: FurnaceSpot[], storehouse: { x: number; y: number; z: number }): Promise<number> {
    return this.smelt(furnaces, storehouse, ORES, FUEL)
  }

  /**
   * Take up to a batch of `input` and fuel from the storehouse, smelt it in the first of the
   * furnaces it can get to and use, put the work back. A furnace out of reach is left alone a
   * while; one that is not the court's is used only when empty (never anyone's things taken).
   */
  async smelt(
    furnaces: FurnaceSpot[],
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
    let made = 0
    for (const spot of usableFurnaces(furnaces)) {
      const window = await this.openAt(spot)
      if (!window) continue
      made = await this.work(window, stuff, fuels)
      break
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

  /**
   * Walk to a furnace and open it, if it can be used: the court's own always (what is left in it
   * is the court's: taken out first), anyone else's only when nothing at all is in it.
   */
  private async openAt(spot: FurnaceSpot): Promise<Furnace | undefined> {
    const at = spot.at
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(at.x, at.y, at.z, 2)),
        30_000
      )
    } catch (err) {
      this.bot.pathfinder.setGoal(null)
      this.log.info(`could not get to the furnace at ${at}: ${errMsg(err)}`)
      shun(at, UNREACHABLE_MS)
      return undefined
    }
    const block = this.bot.blockAt(at)
    if (!block || !/furnace$/.test(block.name)) return undefined
    let window: Furnace
    try {
      window = await withTimeout(this.bot.openFurnace(block), 8_000)
    } catch (err) {
      this.log.info(`could not open the furnace at ${at}: ${errMsg(err)}`)
      shun(at, IN_USE_MS)
      return undefined
    }
    const busy = window.inputItem() || window.outputItem() || window.fuelItem()
    if (busy && !spot.own) {
      this.log.info(`the furnace at ${at} is someone's, in use: another`)
      window.close()
      shun(at, IN_USE_MS)
      return undefined
    }
    try {
      // The court's own: last time's work, or a batch someone left, comes out first.
      if (window.outputItem()) await window.takeOutput()
      if (window.inputItem()) await window.takeInput()
    } catch (err) {
      this.log.info(`could not empty the furnace at ${at}: ${errMsg(err)}`)
      window.close()
      shun(at, IN_USE_MS)
      return undefined
    }
    return window
  }

  /** Fuel and a batch into the open furnace; wait for it; the work and the rest come out. */
  private async work(
    window: Furnace,
    stuff: { type: number; metadata: number; count: number; name: string },
    fuels: RegExp[]
  ): Promise<number> {
    let made = 0
    try {
      const fuel = this.bot.inventory
        .items()
        .find((i) => fuels.some((f) => f.test(i.name)) && i.name !== stuff.name)
      const n = Math.min(BATCH, stuff.count)
      // Fuel of another kind still burning in it: wait for it rather than mix them.
      const burning = window.fuelItem()
      if (fuel && (!burning || burning.name === fuel.name))
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
    return made
  }
}
