import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { craft, makePlanks } from './crafting'

/**
 * The court's mine: a staircase going down one step for every step forward from its entrance,
 * two blocks high, so it can always be walked back up. It goes on from where it stopped.
 */
export interface Mine {
  /** The entrance: feet on the first step. */
  x: number
  y: number
  z: number
  /** Which way it goes down. */
  dx: number
  dz: number
  /** Steps dug so far. */
  steps: number
  /** Why it stopped for good (water, lava, a cave), if it did. */
  ended?: string
}

/** Stone that gives cobblestone, and the ores worth taking on the way. */
export const STONE =
  /^(stone|cobblestone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate)$/
export const ORE = /^(deepslate_)?(coal|iron|copper)_ore$/
/** Iron and copper need a stone pickaxe at least. */
const NEEDS_STONE_PICK = /(iron|copper)_ore$/
const DANGER = /^(flowing_)?(water|lava)$/
/** No deeper than this (caves and lava lie further down). */
export const MAX_STEPS = 18
const PICKS = [/^iron_pickaxe$/, /^stone_pickaxe$/, /^wooden_pickaxe$/]

/** Where the staircase's n-th step puts the feet. */
export function stepAt(mine: Mine, n: number): Vec3 {
  return new Vec3(mine.x + mine.dx * n, mine.y - n, mine.z + mine.dz * n)
}

/** The blocks to dig for step n: the feet, the head, and the headroom of stepping down. */
export function stepCells(mine: Mine, n: number): Vec3[] {
  const f = stepAt(mine, n)
  return [f.offset(0, 2, 0), f.offset(0, 1, 0), f]
}

type MineBot = MineflayerBot & { pathfinder: Pathfinder }

export interface MineResult {
  steps: number
  cobblestone: number
  ores: number
  ended?: string
}

/**
 * Digs the court's mine on for cobblestone (and whatever coal, iron or copper ore shows in its
 * walls), with a pickaxe it makes itself: wooden first, stone as soon as it has cobblestone.
 */
export class Miner {
  private readonly bot: MineBot
  private cancelled = false

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger
  ) {
    this.bot = bot as MineBot
  }

  cancel(): void {
    this.cancelled = true
    this.bot.pathfinder.setGoal(null)
  }

  private count(items: RegExp | string): number {
    const test =
      typeof items === 'string' ? (n: string) => n === items : (n: string) => items.test(n)
    return this.bot.inventory
      .items()
      .filter((i) => test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  private names = (p: Vec3) => this.bot.blockAt(p)?.name

  /** The best pickaxe carried; makes a wooden one (or a stone one, with cobblestone) if none. */
  async pickaxe(): Promise<string | undefined> {
    if (this.count('stone_pickaxe') === 0 && this.count('cobblestone') >= 3) {
      if (this.count('stick') < 2) await this.sticks()
      await craft(this.bot, this.log, 'stone_pickaxe', 1)
    }
    for (const kind of PICKS) {
      const pick = this.bot.inventory.items().find((i) => kind.test(i.name))
      if (pick) return pick.name
    }
    if (this.count('stick') < 2) await this.sticks()
    if (this.count(/_planks$/) < 3) await makePlanks(this.bot, this.log, 3)
    await craft(this.bot, this.log, 'wooden_pickaxe', 1)
    return this.bot.inventory.items().find((i) => i.name === 'wooden_pickaxe')?.name
  }

  private async sticks(): Promise<void> {
    if (this.count(/_planks$/) < 2) await makePlanks(this.bot, this.log, 2)
    await craft(this.bot, this.log, 'stick', 1)
  }

  /** Dig on until `want` cobblestone (or the mine ends); then walk back up to the entrance. */
  async dig(mine: Mine, want: number): Promise<MineResult> {
    this.cancelled = false
    const result: MineResult = { steps: 0, cobblestone: 0, ores: 0 }
    const pick = await this.pickaxe()
    if (!pick) {
      this.log.info('no pickaxe: cannot mine')
      return result
    }
    const before = this.count('cobblestone')
    const until = Date.now() + 5 * 60_000
    while (!this.cancelled && Date.now() < until && this.count('cobblestone') - before < want) {
      if (mine.ended) break
      if (mine.steps >= MAX_STEPS) {
        mine.ended = 'deep enough'
        break
      }
      const n = mine.steps + 1
      const danger = this.danger(mine, n)
      if (danger) {
        mine.ended = danger
        this.log.info(`the mine stops at step ${n}: ${danger}`)
        break
      }
      for (const cell of stepCells(mine, n)) await this.digAt(cell)
      try {
        const f = stepAt(mine, n)
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalBlock(f.x, f.y, f.z)), 15_000)
      } catch (err) {
        this.log.info(`could not step down to step ${n}: ${errMsg(err)}`)
        this.bot.pathfinder.setGoal(null)
        break
      }
      mine.steps = n
      result.steps++
      result.ores += await this.oresAround(stepAt(mine, n))
      // A torch every fourth step: no monsters spawning in the dark of the stairs.
      if (n % 4 === 0) await this.torch(stepAt(mine, n - 1))
      // Upgrade the pickaxe as soon as the cobblestone allows.
      if (this.count('stone_pickaxe') === 0 && this.count('cobblestone') >= 3) await this.pickaxe()
    }
    result.cobblestone = Math.max(0, this.count('cobblestone') - before)
    result.ended = mine.ended
    // Back up the stairs.
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(mine.x, mine.y, mine.z, 1)),
        40_000
      )
    } catch {
      this.bot.pathfinder.setGoal(null)
    }
    this.log.info(
      `mined ${result.steps} steps (${mine.steps} in all): ${result.cobblestone} cobblestone, ${result.ores} ores`
    )
    return result
  }

  /** Water or lava next to the step, or a hollow under it (a cave): the mine ends there. */
  private danger(mine: Mine, n: number): string | undefined {
    const cells = stepCells(mine, n)
    for (const c of cells)
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ]) {
        const name = this.names(c.offset(dx, dy, dz))
        if (name === undefined) return 'the ground there is not to be seen'
        if (DANGER.test(name)) return /lava/.test(name) ? 'lava' : 'water'
      }
    const below = this.names(stepAt(mine, n).offset(0, -1, 0))
    if (below === 'air' || below === 'cave_air') return 'a cave below'
    return undefined
  }

  private async digAt(p: Vec3): Promise<void> {
    const block = this.bot.blockAt(p)
    if (!block || /^(air|cave_air)$/.test(block.name) || block.name === 'torch') return
    await this.toolFor(block.name)
    try {
      await withTimeout(this.bot.dig(block, true), 15_000)
    } catch (err) {
      this.log.info(`could not dig ${block.name} at ${p}: ${errMsg(err)}`)
    }
  }

  /** Pickaxe for stone and ore, hands (or a shovel) for dirt. */
  private async toolFor(name: string): Promise<void> {
    const stone = STONE.test(name) || ORE.test(name)
    const tool = stone
      ? PICKS.map((k) => this.bot.inventory.items().find((i) => k.test(i.name))).find(Boolean)
      : this.bot.inventory.items().find((i) => /_shovel$/.test(i.name))
    if (tool && this.bot.heldItem?.name !== tool.name)
      await this.bot.equip(tool, 'hand').catch(() => {})
  }

  /** Ores in the walls around the step, within reach: dig them (if the pickaxe can). */
  private async oresAround(f: Vec3): Promise<number> {
    let taken = 0
    const stonePick = this.count(/^(stone|iron)_pickaxe$/) > 0
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 2; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const p = f.offset(dx, dy, dz)
          const name = this.names(p)
          if (!name || !ORE.test(name)) continue
          if (NEEDS_STONE_PICK.test(name) && !stonePick) continue
          await this.digAt(p)
          taken++
        }
    if (taken) await sleep(500)
    return taken
  }

  /** A torch standing on a step (the one behind: the bot stands on this one). */
  private async torch(step: Vec3): Promise<void> {
    const torch = this.bot.inventory.items().find((i) => i.name === 'torch')
    const floor = this.bot.blockAt(step.offset(0, -1, 0))
    if (!torch || !floor || floor.boundingBox !== 'block') return
    try {
      await this.bot.equip(torch, 'hand')
      await withTimeout(this.bot.placeBlock(floor, new Vec3(0, 1, 0)), 3_000)
    } catch {
      // A torch is a nicety: never mind.
    }
  }
}

/**
 * Where the court's mine starts: flat soil 10 to 24 blocks from home, away from the hall and the
 * field, with the ground running on the same way for a few steps (so the stairs start in the
 * open, not under a wall).
 */
export function chooseMine(
  names: (x: number, y: number, z: number) => string | undefined,
  home: { x: number; y: number; z: number },
  clear: Array<[number, number]>
): Mine | undefined {
  const SOIL = /^(grass_block|dirt|coarse_dirt|podzol|stone|andesite|diorite|granite)$/
  const OPEN = /^(air|short_grass|tall_grass|fern|large_fern|[a-z_]*flower|poppy|dandelion)$/
  for (let r = 10; r <= 24; r += 2)
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]) {
      const x = home.x + dx * r
      const z = home.z + dz * r
      if (clear.some(([cx, cz]) => Math.abs(cx - x) <= 5 && Math.abs(cz - z) <= 5)) continue
      for (let y = home.y + 3; y >= home.y - 4; y--) {
        if (!SOIL.test(names(x, y - 1, z) ?? '') || !OPEN.test(names(x, y, z) ?? '')) continue
        if (!OPEN.test(names(x, y + 1, z) ?? '')) break
        // Going on outward, away from home.
        return { x, y, z, dx, dz, steps: 0 }
      }
    }
  return undefined
}
