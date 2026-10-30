import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { groveNeed, SAPLING, type Grove } from '../build/grove'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import type { Gatherer } from './gathering'

type ForestBot = MineflayerBot & { pathfinder: Pathfinder }
type Block = NonNullable<ReturnType<MineflayerBot['blockAt']>>

const LOG = /_log$/
const AXE = /_axe$/
const UP = new Vec3(0, 1, 0)
/** The tallest trunk it looks for (a birch is five to seven logs). */
const TRUNK = 12
/** Dirt to climb on to the top of a trunk, taken down again. */
const CLIMB_DIRT = 8
/** What goes into the storehouse after a round. */
const KEEP = /_log$|_sapling$|^(stick|apple)$/

export interface ForestResult {
  felled: number
  logs: number
  planted: number
}

/**
 * Keeps the court's grove: fells the grown trees (the trunk, climbing a dirt pillar to the top,
 * and the leaves within reach, which drop saplings), plants a sapling on every bare spot, and
 * takes the logs, sticks and apples to the storehouse.
 */
export class Forester {
  private readonly bot: ForestBot

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly gatherer: Gatherer
  ) {
    this.bot = bot as ForestBot
  }

  private count(items: RegExp): number {
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  private names = (x: number, y: number, z: number) => this.bot.blockAt(new Vec3(x, y, z))?.name

  async tend(
    grove: Grove,
    storehouse?: { x: number; y: number; z: number }
  ): Promise<ForestResult> {
    const result: ForestResult = { felled: 0, logs: 0, planted: 0 }
    const logsBefore = this.count(LOG)
    // From the storehouse: saplings, an axe, dirt to climb a trunk on.
    if (storehouse)
      await this.gatherer.withChest(storehouse, async (chest) => {
        for (const item of chest.containerItems()) {
          const take =
            SAPLING.test(item.name) ||
            (AXE.test(item.name) && this.count(AXE) === 0) ||
            (item.name === 'dirt' && this.count(/^dirt$/) < CLIMB_DIRT)
          const n = item.name === 'dirt' ? Math.min(item.count, CLIMB_DIRT) : item.count
          if (take) await withTimeout(chest.withdraw(item.type, item.metadata, n), 5_000)
        }
        return 0
      })
    const me = this.bot.entity.position
    const spots = [...grove.spots].sort(
      (a, b) => Math.hypot(a[0] - me.x, a[2] - me.z) - Math.hypot(b[0] - me.x, b[2] - me.z)
    )
    for (const [x, y, z] of spots) {
      let need = groveNeed(this.names(x, y, z), this.names(x, y + 1, z))
      if (need === 'fell') {
        if (await this.fell(x, y, z)) result.felled++
        need = groveNeed(this.names(x, y, z), this.names(x, y + 1, z))
      }
      if (need === 'plant' && this.count(SAPLING) > 0 && (await this.plant(x, y, z)))
        result.planted++
    }
    // Saplings that fell from the leaves meanwhile, round the grove.
    await this.pickUpAround(grove)
    for (const [x, y, z] of spots)
      if (groveNeed(this.names(x, y, z), this.names(x, y + 1, z)) === 'plant')
        if (this.count(SAPLING) > 0 && (await this.plant(x, y, z))) result.planted++
    result.logs = Math.max(0, this.count(LOG) - logsBefore)
    if (storehouse) await this.store(storehouse)
    this.log.info(
      `the grove: ${result.felled} felled (${result.logs} logs), ${result.planted} planted`
    )
    return result
  }

  /** Fell the tree on this spot: the trunk bottom up, then the leaves within reach. */
  private async fell(x: number, y: number, z: number): Promise<boolean> {
    if (this.count(/^dirt$/) < 4) await this.gatherer.collect('dirt', CLIMB_DIRT)
    const axe = this.bot.inventory.items().find((i) => AXE.test(i.name))
    if (axe) await this.bot.equip(axe, 'hand').catch(() => {})
    let top = y + 1
    while (top < y + TRUNK && LOG.test(this.names(x, top + 1, z) ?? '')) top++
    for (let ly = y + 1; ly <= top; ly++) {
      const p = new Vec3(x, ly, z)
      if (!LOG.test(this.names(x, ly, z) ?? '')) continue
      await this.gatherer.digOne('wood', p)
      if (LOG.test(this.names(x, ly, z) ?? '')) {
        this.log.info(`could not fell the log at ${p}`)
        break
      }
    }
    await this.gatherer.leavesForSaplings(new Vec3(x, y + 4, z), 64)
    return !LOG.test(this.names(x, y + 1, z) ?? '')
  }

  /** Put a sapling on the spot's soil. */
  private async plant(x: number, y: number, z: number): Promise<boolean> {
    const soil = this.bot.blockAt(new Vec3(x, y, z))
    const sapling = this.bot.inventory.items().find((i) => SAPLING.test(i.name))
    if (!soil || !sapling) return false
    if (!(await this.near(x, y, z))) return false
    // Grass on the spot is in the way.
    const cover = this.bot.blockAt(new Vec3(x, y + 1, z))
    if (cover && cover.name !== 'air')
      await withTimeout(this.bot.dig(cover, true), 3_000).catch(() => {})
    return this.use(sapling.name, soil)
  }

  private async use(item: string, block: Block): Promise<boolean> {
    const held = this.bot.inventory.items().find((i) => i.name === item)
    if (!held) return false
    try {
      await this.bot.equip(held, 'hand')
      await this.bot.activateBlock(block, UP)
    } catch (err) {
      this.log.debug(`could not plant ${item}: ${errMsg(err)}`)
      return false
    }
    for (let i = 0; i < 6; i++) {
      await sleep(150)
      if (SAPLING.test(this.names(block.position.x, block.position.y + 1, block.position.z) ?? ''))
        return true
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

  /** Walk onto what lies on the ground in the grove (saplings, sticks, apples from the leaves). */
  private async pickUpAround(grove: Grove): Promise<void> {
    const near = (p: Vec3) =>
      grove.spots.some(([x, y, z]) => p.distanceTo(new Vec3(x + 0.5, y + 1, z + 0.5)) < 6)
    const drops = Object.values(this.bot.entities).filter(
      (e) => e.name === 'item' && near(e.position)
    )
    for (const drop of drops.slice(0, 16)) {
      const p = drop.position
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)),
        8_000
      ).catch(() => this.bot.pathfinder.setGoal(null))
    }
    await sleep(300)
  }

  /** Logs, sticks, apples and saplings into the storehouse, for whoever tends the grove next. */
  private async store(storehouse: { x: number; y: number; z: number }): Promise<void> {
    if (!this.bot.inventory.items().some((i) => KEEP.test(i.name))) return
    await this.gatherer.withChest(storehouse, async (chest) => {
      for (const item of this.bot.inventory.items().filter((i) => KEEP.test(i.name)))
        await withTimeout(chest.deposit(item.type, item.metadata, item.count), 5_000)
      return 0
    })
  }
}
