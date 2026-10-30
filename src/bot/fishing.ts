import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { FishingSpot } from '../build/fishing'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { craft, makePlanks } from './crafting'
import type { Gatherer } from './gathering'
import { duskFallen } from './survival'

type FishBot = MineflayerBot & { pathfinder: Pathfinder; fish: () => Promise<void> }

const ROD = /^fishing_rod$/
/** What a line brings up: fish to cook (pufferfish is never eaten), and whatever else bites. */
const FISH = /^(cod|salmon)$/
/** All of the catch goes to the storehouse (the rod too, for whoever fishes next). */
const CATCH =
  /^(cod|salmon|tropical_fish|pufferfish|fishing_rod|bowl|leather|leather_boots|string|stick|bone|ink_sac|lily_pad|tripwire_hook|rotten_flesh|bow|enchanted_book|name_tag|saddle|nautilus_shell|water_bottle|potion)$/
/** How long one cast may wait for a bite. */
const CAST_MS = 45_000
/** Casts that came to nothing in a row before giving up (the line keeps landing on dry land). */
const DRY_CASTS = 3

export interface FishResult {
  fish: number
  casts: number
}

/**
 * Fishes for the court's food: a rod (from the storehouse, or made of three sticks and two
 * string), stands on the shore of the court's fishing water, casts at it and reels in each bite,
 * for a few minutes; then the catch goes to the storehouse to be cooked.
 */
export class Fisher {
  private readonly bot: FishBot
  private cancelled = false

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly gatherer: Gatherer
  ) {
    this.bot = bot as FishBot
  }

  cancel(): void {
    this.cancelled = true
  }

  private count(items: RegExp): number {
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  async fish(
    spot: FishingSpot,
    ms: number,
    storehouse?: { x: number; y: number; z: number }
  ): Promise<FishResult> {
    this.cancelled = false
    const result: FishResult = { fish: 0, casts: 0 }
    if (!(await this.rod(storehouse))) {
      this.log.info('no fishing rod, nor string and sticks to make one')
      return result
    }
    const [sx, sy, sz] = spot.stand
    try {
      await withTimeout(this.bot.pathfinder.goto(new goals.GoalBlock(sx, sy, sz)), 60_000)
    } catch (err) {
      this.bot.pathfinder.setGoal(null)
      this.log.info(`could not get to the fishing spot: ${errMsg(err)}`)
      return result
    }
    const [wx, wy, wz] = spot.water
    const before = this.count(FISH)
    const until = Date.now() + ms
    let dry = 0
    while (Date.now() < until && !this.cancelled && dry < DRY_CASTS) {
      if (duskFallen(this.bot.time?.timeOfDay)) break
      const rod = this.bot.inventory.items().find((i) => ROD.test(i.name))
      if (!rod) break
      await this.bot.equip(rod, 'hand').catch(() => {})
      // Aim a little above the water: the line flies in an arc.
      await this.bot.lookAt(new Vec3(wx + 0.5, wy + 1.5, wz + 0.5)).catch(() => {})
      const had = this.count(CATCH)
      result.casts++
      try {
        await withTimeout(this.bot.fish(), CAST_MS)
      } catch (err) {
        // No bite in time (or the line landed on dry land): reel in and cast again.
        this.log.debug(`cast ${result.casts}: ${errMsg(err)}`)
        this.bot.activateItem()
      }
      await sleep(1_500)
      if (this.count(CATCH) > had) dry = 0
      else dry++
    }
    result.fish = Math.max(0, this.count(FISH) - before)
    if (storehouse) await this.store(storehouse)
    this.log.info(`fishing: ${result.fish} fish in ${result.casts} casts`)
    return result
  }

  /** A rod in hand: carried, from the storehouse, or made (three sticks, two string, a table). */
  private async rod(storehouse?: { x: number; y: number; z: number }): Promise<boolean> {
    if (this.count(ROD) > 0) return true
    if (storehouse)
      await this.gatherer.withChest(storehouse, async (chest) => {
        const take = async (items: RegExp, n: number) => {
          for (const item of chest.containerItems().filter((i) => items.test(i.name))) {
            if (n <= 0) break
            const k = Math.min(n, item.count)
            await withTimeout(chest.withdraw(item.type, item.metadata, k), 5_000)
            n -= k
          }
          return n
        }
        if ((await take(ROD, 1)) === 0) return 0
        await take(/^string$/, 2)
        if (this.count(/^stick$/) < 3) await take(/^stick$/, 3)
        if (this.count(/^stick$/) < 3 && (await take(/_planks$/, 2)) > 0) await take(/_log$/, 1)
        return 0
      })
    if (this.count(ROD) > 0) return true
    if (this.count(/^string$/) < 2) return false
    if (this.count(/^stick$/) < 3) {
      if (this.count(/_planks$/) < 2) await makePlanks(this.bot, this.log, 2)
      await craft(this.bot, this.log, 'stick', 1)
    }
    return craft(this.bot, this.log, 'fishing_rod', 1)
  }

  /** The catch (and the rod) into the storehouse. */
  private async store(storehouse: { x: number; y: number; z: number }): Promise<void> {
    await this.gatherer.withChest(storehouse, async (chest) => {
      for (const item of this.bot.inventory.items().filter((i) => CATCH.test(i.name)))
        await withTimeout(chest.deposit(item.type, item.metadata, item.count), 5_000)
      return 0
    })
  }
}
