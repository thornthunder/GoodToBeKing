import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { farmNeed, type Farm } from '../build/farm'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { craft } from './crafting'
import type { Gatherer } from './gathering'

type FarmBot = MineflayerBot & { pathfinder: Pathfinder }
type Block = NonNullable<ReturnType<MineflayerBot['blockAt']>>

const HOE = /_hoe$/
const SEEDS = 'wheat_seeds'
/** Grass breaks for seeds now and then (one in eight). */
const GRASS = /^(short_grass|tall_grass|fern|large_fern)$/
const UP = new Vec3(0, 1, 0)

export interface FarmResult {
  tilled: number
  planted: number
  harvested: number
  /** Loaves baked from the wheat. */
  bread: number
}

/**
 * Keeps the court's wheat field: a hoe (crafted, or from the storehouse), seeds (from the
 * storehouse, or grass broken for them), tilling, planting, harvesting what is ripe and
 * replanting; the wheat becomes bread and goes to the storehouse with what seeds are spare.
 */
export class Farmer {
  private readonly bot: FarmBot

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly gatherer: Gatherer
  ) {
    this.bot = bot as FarmBot
  }

  private count(name: RegExp | string): number {
    const test = typeof name === 'string' ? (n: string) => n === name : (n: string) => name.test(n)
    return this.bot.inventory
      .items()
      .filter((i) => test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  async tend(farm: Farm, storehouse?: { x: number; y: number; z: number }): Promise<FarmResult> {
    const result: FarmResult = { tilled: 0, planted: 0, harvested: 0, bread: 0 }
    // What the storehouse has for the field: a hoe, seeds, wheat waiting to be baked.
    if (storehouse) {
      await this.gatherer.withChest(storehouse, async (chest) => {
        for (const item of chest.containerItems()) {
          const take =
            (HOE.test(item.name) && this.count(HOE) === 0) ||
            item.name === SEEDS ||
            item.name === 'wheat'
          if (take) await withTimeout(chest.withdraw(item.type, item.metadata, item.count), 5_000)
        }
        // A little wood for a hoe and a crafting table.
        if (this.count(HOE) === 0 && this.count(/_planks$|_log$/) < 3) {
          const log = chest.containerItems().find((i) => /_log$/.test(i.name))
          if (log)
            await withTimeout(chest.withdraw(log.type, log.metadata, Math.min(3, log.count)), 5_000)
        }
        return 0
      })
    }
    if (this.count(HOE) === 0) {
      if (this.count('stick') < 2) await craft(this.bot, this.log, 'stick', 1)
      await craft(this.bot, this.log, 'wooden_hoe', 1)
    }
    const hoe = this.bot.inventory.items().find((i) => HOE.test(i.name))
    if (!hoe) this.log.info('no hoe: cannot till the field')
    if (this.count(SEEDS) < farm.cells.length) await this.seedsFromGrass(farm, 24)
    // The field, square by square, nearest first.
    const me = this.bot.entity.position
    const cells = [...farm.cells].sort(
      (a, b) => Math.hypot(a[0] - me.x, a[1] - me.z) - Math.hypot(b[0] - me.x, b[1] - me.z)
    )
    for (const [x, z] of cells) {
      const soil = this.bot.blockAt(new Vec3(x, farm.y, z))
      const crop = this.bot.blockAt(new Vec3(x, farm.y + 1, z))
      const growth = Number(crop?.getProperties?.()?.growth ?? 0)
      let need = farmNeed(soil?.name, crop?.name, growth)
      if (!need || !soil) continue
      if (!(await this.near(x, farm.y, z))) continue
      if (need === 'harvest' && crop) {
        try {
          await withTimeout(this.bot.dig(crop, true), 5_000)
          result.harvested++
          await this.pickUp(new Vec3(x, farm.y + 1, z))
        } catch (err) {
          this.log.info(`could not harvest at ${x},${z}: ${errMsg(err)}`)
          continue
        }
        need = 'plant'
      }
      if (need === 'till' && hoe) {
        if (crop && GRASS.test(crop.name))
          await withTimeout(this.bot.dig(crop, true), 5_000).catch(() => {})
        if (await this.use(hoe.name, soil)) result.tilled++
        need = this.bot.blockAt(new Vec3(x, farm.y, z))?.name === 'farmland' ? 'plant' : null
      }
      if (need === 'plant' && this.count(SEEDS) > 0) {
        const farmland = this.bot.blockAt(new Vec3(x, farm.y, z))
        if (farmland?.name === 'farmland' && (await this.use(SEEDS, farmland))) result.planted++
      }
    }
    // Bread from the wheat, three to a loaf.
    const wheat = this.count('wheat')
    if (wheat >= 3 && (await craft(this.bot, this.log, 'bread', Math.floor(wheat / 3))))
      result.bread = Math.floor(wheat / 3)
    if (storehouse) await this.store(storehouse, farm.cells.length)
    this.log.info(
      `the field: ${result.harvested} harvested, ${result.tilled} tilled, ${result.planted} planted, ${result.bread} bread`
    )
    return result
  }

  /** Break grass near the field until there are `want` seeds (or it has tried enough). */
  private async seedsFromGrass(farm: Farm, want: number): Promise<void> {
    const [cx, cz] = farm.cells[0]
    for (let tries = 0; tries < 60 && this.count(SEEDS) < want; tries++) {
      const grass = this.bot.findBlocks({
        matching: (b: { name: string }) => GRASS.test(b.name),
        point: new Vec3(cx, farm.y + 1, cz),
        maxDistance: 24,
        count: 1,
      })[0]
      const block = grass && this.bot.blockAt(grass)
      if (!block) return
      if (!(await this.near(block.position.x, block.position.y, block.position.z))) continue
      await withTimeout(this.bot.dig(block, true), 5_000).catch(() => {})
      await this.pickUp(block.position)
    }
  }

  /** Use an item on the top of a block (a hoe on soil, seeds on farmland). */
  private async use(item: string, block: Block): Promise<boolean> {
    const held = this.bot.inventory.items().find((i) => i.name === item)
    if (!held) return false
    const before = block.name
    try {
      await this.bot.equip(held, 'hand')
      await this.bot.activateBlock(block, UP)
    } catch (err) {
      this.log.debug(`could not use ${item} on ${block.name}: ${errMsg(err)}`)
      return false
    }
    for (let i = 0; i < 5; i++) {
      await sleep(150)
      const p = block.position
      if (this.bot.blockAt(p)?.name !== before) return true
      if (item === SEEDS && this.bot.blockAt(p.offset(0, 1, 0))?.name === 'wheat') return true
    }
    return false
  }

  private async near(x: number, y: number, z: number): Promise<boolean> {
    const eyes = this.bot.entity.position.offset(0, 1.62, 0)
    if (eyes.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) <= 4) return true
    try {
      await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(x, y + 1, z, 2)), 20_000)
      return true
    } catch {
      this.bot.pathfinder.setGoal(null)
      return false
    }
  }

  private async pickUp(near: Vec3): Promise<void> {
    await sleep(400)
    for (const drop of Object.values(this.bot.entities).filter(
      (e) => e.name === 'item' && e.position.distanceTo(near) < 5
    )) {
      const p = drop.position
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)),
        8_000
      ).catch(() => this.bot.pathfinder.setGoal(null))
    }
  }

  /** Bread, wheat and spare seeds go to the storehouse; seeds for the field are kept. */
  private async store(
    storehouse: { x: number; y: number; z: number },
    keepSeeds: number
  ): Promise<void> {
    await this.gatherer.withChest(storehouse, async (chest) => {
      for (const item of this.bot.inventory.items()) {
        if (item.name === 'bread' || item.name === 'wheat')
          await withTimeout(chest.deposit(item.type, item.metadata, item.count), 5_000)
        else if (item.name === SEEDS && item.count > keepSeeds)
          await withTimeout(chest.deposit(item.type, item.metadata, item.count - keepSeeds), 5_000)
      }
      return 0
    })
  }
}
