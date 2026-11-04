import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { craft, makePlanks } from './crafting'

/**
 * The court's mine: a staircase going down one step for every step forward from its entrance,
 * two blocks high, so it can always be walked back up; at its depth a level tunnel, and off the
 * tunnel side branches, right and left in turn, every few steps (a branch mine: the most walls
 * seen for the least digging, and ore shows in walls). It goes on from where it stopped.
 */
export interface Mine {
  /** The entrance: feet on the first step. */
  x: number
  y: number
  z: number
  /** Which way it goes down. */
  dx: number
  dz: number
  /** Steps dug so far along the stairs and the level tunnel. */
  steps: number
  /** Why it stopped for good (worked out, water, lava, a cave), if it did: a new one is begun. */
  ended?: string
  /** Rounds in a row the miner could not get down to the last step. */
  lost?: number
  /** How deep the stairs go (older mines: MAX_STEPS). */
  depth?: number
  /** The level tunnel ends here (stairs counted); then the branches. Older mines: as far as dug. */
  length?: number
  /** The branch being dug (0, 1, 2...), and how far along it is. */
  branch?: number
  branchSteps?: number
}

/**
 * Where a mind keeps its mine: the household's in household.json, the army's in its own file
 * (each mind digs its own, so two miners never share one tunnel).
 */
export interface MineRecord {
  readonly mine: Mine | undefined
  setMine(mine: Mine): void
  /** The entrances of mines worked out or given up: a new one keeps clear of them. */
  readonly oldMines: Array<[number, number]>
  retireMine(mine: Mine): void
}

/** Stone that gives cobblestone, and the ores worth taking on the way. */
export const STONE =
  /^(stone|cobblestone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate)$/
export const ORE = /^(deepslate_)?(coal|iron|copper|gold)_ore$/
/** Iron and copper need a stone pickaxe at least; gold an iron one (else it drops nothing). */
const NEEDS_STONE_PICK = /(iron|copper)_ore$/
const NEEDS_IRON_PICK = /gold_ore$/
const DANGER = /^(flowing_)?(water|lava)$/
/** Older mines' stairs go this deep. */
export const MAX_STEPS = 18
/** A new mine's stairs go this deep (from about 70 to near 38: copper, iron and coal all show). */
export const NEW_DEPTH = 32
/** The level tunnel runs this far past the stairs; branches go off it. */
export const LEVEL_LENGTH = 40
/** The first branch this far along the level tunnel, then one every BRANCH_EVERY, both sides. */
const BRANCH_FIRST = 4
const BRANCH_EVERY = 4
export const BRANCH_LENGTH = 20
/** A level tunnel cut short (water, a cave) still branches if it got this far. */
const SHORT_LEVEL = 8
/** An ore vein is followed this far (blocks in all). */
const VEIN = 16
/** Reach for digging, from the eyes. */
const REACH = 4.5
const PICKS = [/^iron_pickaxe$/, /^stone_pickaxe$/, /^wooden_pickaxe$/]

export function depthOf(mine: Mine): number {
  return mine.depth ?? MAX_STEPS
}

/** Where the level tunnel ends (the stairs counted). */
export function lengthOf(mine: Mine): number {
  return mine.length ?? depthOf(mine) + LEVEL_LENGTH
}

/** Where the staircase's (or the level tunnel's) n-th step puts the feet. */
export function stepAt(mine: Mine, n: number): Vec3 {
  // Down to the depth, then on as a level tunnel.
  const down = Math.min(n, depthOf(mine))
  return new Vec3(mine.x + mine.dx * n, mine.y - down, mine.z + mine.dz * n)
}

/** The blocks to dig for step n: the feet, the head, and the headroom of stepping down. */
export function stepCells(mine: Mine, n: number): Vec3[] {
  const f = stepAt(mine, n)
  // Stepping down needs a third block of headroom; the level tunnel only two.
  return n <= depthOf(mine) ? [f.offset(0, 2, 0), f.offset(0, 1, 0), f] : [f.offset(0, 1, 0), f]
}

/** The level tunnel's step a branch goes off from; undefined past the tunnel's end. */
export function branchStart(mine: Mine, k: number): number | undefined {
  const at = depthOf(mine) + BRANCH_FIRST + BRANCH_EVERY * Math.floor(k / 2)
  return at <= lengthOf(mine) ? at : undefined
}

/** Where the i-th step of branch k puts the feet (i = 0: on the level tunnel). */
export function branchAt(mine: Mine, k: number, i: number): Vec3 | undefined {
  const start = branchStart(mine, k)
  if (start === undefined) return undefined
  // Right of the way down for even branches, left for odd ones.
  const side = k % 2 === 0 ? 1 : -1
  return stepAt(mine, start).offset(-mine.dz * side * i, 0, mine.dx * side * i)
}

/** How many branches a mine has in all. */
export function branchCount(mine: Mine): number {
  let k = 0
  while (branchStart(mine, k) !== undefined) k++
  return k
}

/** Where the miner stands to go on: the last step dug (stairs, tunnel or branch). */
export function lastSpot(mine: Mine): Vec3 {
  if (mine.branch === undefined) return stepAt(mine, mine.steps)
  return branchAt(mine, mine.branch, mine.branchSteps ?? 0) ?? stepAt(mine, mine.steps)
}

type MineBot = MineflayerBot & { pathfinder: Pathfinder }

/** Rounds in a row the miner may fail to get down before the mine is given up for a new one. */
const LOST_ROUNDS = 2

export interface MineResult {
  steps: number
  cobblestone: number
  ores: number
  ended?: string
  /** Gold ore seen in the walls and left, for want of an iron pickaxe. */
  goldSeen?: number
}

/**
 * Digs the court's mine on for cobblestone and whatever coal, iron or copper ore shows in its
 * walls (following each vein), with a pickaxe it makes itself: wooden first, stone as soon as it
 * has cobblestone. Torches every few steps, made of the coal it finds when it has none.
 */
export class Miner {
  private readonly bot: MineBot
  private cancelled = false

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    /** Fighting, eating or out of a creeper's way: the body is taken (bot/survival.ts). */
    private readonly busy: () => boolean = () => false
  ) {
    this.bot = bot as MineBot
  }

  /** Wait while the body is taken (a fight on the way to the mine), a minute at most. */
  private async whileBusy(): Promise<boolean> {
    if (!this.busy()) return false
    const until = Date.now() + 60_000
    while (this.busy() && Date.now() < until && !this.cancelled) await sleep(1_000)
    return true
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

  /** Walk to a spot in the mine: exactly, then once more, then near enough. */
  private async walkTo(p: Vec3, what: string): Promise<boolean> {
    const tries = [
      new goals.GoalBlock(p.x, p.y, p.z),
      new goals.GoalBlock(p.x, p.y, p.z),
      new goals.GoalNear(p.x, p.y, p.z, 1),
    ]
    // A walk broken off by a fight or a flight is waited out and walked again, not counted
    // (on 2026-11-04 the night's monsters broke three walks to the mine's mouth in a row, and
    // the mine was given up for ten minutes).
    let interrupted = 0
    for (let i = 0; i < tries.length && !this.cancelled;) {
      try {
        await withTimeout(this.bot.pathfinder.goto(tries[i]), 40_000)
        return true
      } catch (err) {
        this.bot.pathfinder.setGoal(null)
        if ((await this.whileBusy()) && ++interrupted <= 5) continue
        this.log.info(`could not walk to ${what}: ${errMsg(err)}`)
        await sleep(2_000)
        i++
      }
    }
    return false
  }

  /**
   * Down the stairs and the tunnel a step at a time, from the entrance to the last step dug,
   * clearing each step again on the way; then on to the branch being dug, if any.
   */
  private async descend(mine: Mine): Promise<boolean> {
    this.log.info(`walking the mine's ${mine.steps} steps one by one`)
    if (!(await this.walkTo(new Vec3(mine.x, mine.y, mine.z), 'the entrance'))) return false
    for (let i = 1; i <= mine.steps; i++) {
      if (this.cancelled) return false
      for (const cell of stepCells(mine, i)) await this.digAt(cell)
      const f = stepAt(mine, i)
      try {
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalBlock(f.x, f.y, f.z)), 15_000)
      } catch (err) {
        this.log.info(`could not get down to step ${i}: ${errMsg(err)}`)
        this.bot.pathfinder.setGoal(null)
        return false
      }
    }
    if (mine.branch === undefined) return true
    return this.walkTo(lastSpot(mine), `branch ${mine.branch + 1}`)
  }

  /** Dig on until `want` cobblestone and ore (or the mine ends); then walk back up. */
  async dig(mine: Mine, want: number): Promise<MineResult> {
    this.cancelled = false
    const result: MineResult = { steps: 0, cobblestone: 0, ores: 0 }
    const pick = await this.pickaxe()
    if (!pick) {
      this.log.info('no pickaxe: cannot mine')
      return result
    }
    const before = this.count('cobblestone')
    this.oresTaken = 0
    this.goldLeft.clear()
    const until = Date.now() + 6 * 60_000
    // The level tunnel done: on to the branches (walked to straight, not to the tunnel's end).
    if (mine.branch === undefined && mine.steps >= lengthOf(mine)) {
      mine.branch = 0
      mine.branchSteps = 0
    }
    // A new mine: to its entrance first (its first step is dug from there, within reach).
    if (
      mine.steps === 0 &&
      !(await this.walkTo(new Vec3(mine.x, mine.y, mine.z), 'the entrance'))
    ) {
      mine.lost = (mine.lost ?? 0) + 1
      if (mine.lost >= LOST_ROUNDS) mine.ended = 'unreachable'
      result.ended = mine.ended
      return result
    }
    // Down the stairs dug before, to where it stopped: the next is dug from there, within reach.
    // The pathfinder gives up on a long way down a dark stair (on 2026-11-03 "took too long to
    // decide" cost a side three rounds of its ten days); then the stairs are walked a step at a
    // time, each cleared again on the way (gravel falls, a monster's hole).
    if (mine.steps > 0) {
      if (
        !(await this.walkTo(lastSpot(mine), `the mine's end (step ${mine.steps})`)) &&
        !(await this.descend(mine))
      ) {
        mine.lost = (mine.lost ?? 0) + 1
        // Three rounds in a row: the stairs are blocked or overrun; a new mine is begun.
        if (mine.lost >= LOST_ROUNDS) mine.ended = 'unreachable'
        result.ended = mine.ended
        return result
      }
      mine.lost = 0
    }
    const got = () => this.count('cobblestone') - before + this.oresTaken
    while (!this.cancelled && Date.now() < until && got() < want) {
      if (mine.ended) break
      if (mine.branch === undefined && mine.steps >= lengthOf(mine)) {
        // The level tunnel is done: on to the branches.
        mine.branch = 0
        mine.branchSteps = 0
      }
      const ok = mine.branch === undefined ? await this.stepOn(mine) : await this.branchOn(mine)
      if (!ok) break
      result.steps++
    }
    result.cobblestone = Math.max(0, this.count('cobblestone') - before)
    result.ores = this.oresTaken
    result.goldSeen = this.goldLeft.size
    result.ended = mine.ended
    // Back up the stairs.
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(mine.x, mine.y, mine.z, 1)),
        60_000
      )
    } catch {
      this.bot.pathfinder.setGoal(null)
    }
    const where =
      mine.branch === undefined
        ? `${mine.steps} steps`
        : `branch ${mine.branch + 1} of ${branchCount(mine)}`
    this.log.info(
      `mined ${result.steps} steps (${where}): ${result.cobblestone} cobblestone, ${result.ores} ores`
    )
    return result
  }

  private oresTaken = 0
  /** Gold ore left in the walls this trip (by position), for want of an iron pickaxe. */
  private readonly goldLeft = new Set<string>()

  /** One more step of the stairs or the level tunnel. False when it cannot go on now. */
  private async stepOn(mine: Mine): Promise<boolean> {
    const n = mine.steps + 1
    const danger = this.danger(stepCells(mine, n), stepAt(mine, n))
    const stop = (why: string) => {
      this.log.info(`the mine's tunnel stops at step ${n}: ${why}`)
      // Far enough along the level to branch off what there is; else it is no mine at all.
      if (mine.steps >= depthOf(mine) + SHORT_LEVEL) mine.length = mine.steps
      else mine.ended = why
      return true
    }
    // A hollow under the next step is bridged with a block carried (dug out of the stair above);
    // water and lava end the tunnel. (Ended at every hollow, two shafts in a row gave out at
    // their first step in the war game's oak wood, 2026-11-04.)
    const hollow = danger === 'a cave below'
    if (danger && !hollow) return stop(danger)
    for (const cell of stepCells(mine, n)) await this.digAt(cell)
    const f = stepAt(mine, n)
    if (hollow && !(await this.floorUnder(f))) return stop('a cave below')
    try {
      await withTimeout(this.bot.pathfinder.goto(new goals.GoalBlock(f.x, f.y, f.z)), 15_000)
    } catch (err) {
      this.log.info(`could not step down to step ${n}: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
      return false
    }
    mine.steps = n
    this.oresTaken += await this.oresAround(f)
    // A torch every fourth step: no monsters spawning in the dark of the stairs.
    if (n % 4 === 0) await this.torch(stepAt(mine, n - 1))
    return true
  }

  /** One more step along the branch being dug, or on to the next branch. */
  private async branchOn(mine: Mine): Promise<boolean> {
    const k = mine.branch ?? 0
    if (branchStart(mine, k) === undefined) {
      mine.ended = 'worked out'
      this.log.info('the mine is worked out: every branch dug')
      return true
    }
    const i = (mine.branchSteps ?? 0) + 1
    const next = () => {
      mine.branch = k + 1
      mine.branchSteps = 0
    }
    if (i > BRANCH_LENGTH) {
      next()
      // Back to the level tunnel, where the next branch begins.
      const start = branchAt(mine, k + 1, 0)
      return start ? this.walkTo(start, `branch ${k + 2}`) : true
    }
    const f = branchAt(mine, k, i)
    const start = branchAt(mine, k, 0)
    if (!f || !start) return false
    // A new branch: from where it leaves the level tunnel (the miner may be at the tunnel's end).
    if (i === 1 && this.bot.entity.position.distanceTo(start.offset(0.5, 0, 0.5)) > 1.5)
      if (!(await this.walkTo(start, `branch ${k + 1}`))) return false
    const cells = [f.offset(0, 1, 0), f]
    const danger = this.danger(cells, f)
    if (danger) {
      this.log.info(`branch ${k + 1} stops at ${i}: ${danger}`)
      next()
      const start = branchAt(mine, k + 1, 0)
      return start ? this.walkTo(start, `branch ${k + 2}`) : true
    }
    for (const cell of cells) await this.digAt(cell)
    try {
      await withTimeout(this.bot.pathfinder.goto(new goals.GoalBlock(f.x, f.y, f.z)), 15_000)
    } catch (err) {
      this.log.info(`could not step into branch ${k + 1} at ${i}: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
      return false
    }
    mine.branchSteps = i
    this.oresTaken += await this.oresAround(f)
    if (i % 6 === 0) await this.torch(branchAt(mine, k, i - 1) ?? f)
    return true
  }

  /** Water or lava next to the cells, or a hollow under the feet (a cave). */
  private danger(cells: Vec3[], feet: Vec3): string | undefined {
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
    const below = this.names(feet.offset(0, -1, 0))
    if (below === 'air' || below === 'cave_air') return 'a cave below'
    return undefined
  }

  /**
   * A block put where the feet's floor should be (the step's own cells dug, so the hollow below
   * is in sight): stone or earth from the pockets. Whether the step has a floor now.
   */
  private async floorUnder(f: Vec3): Promise<boolean> {
    const floor = f.offset(0, -1, 0)
    const solid = (p: Vec3) => this.bot.blockAt(p)?.boundingBox === 'block'
    if (solid(floor)) return true
    const item = this.bot.inventory
      .items()
      .find((i) =>
        /^(cobblestone|cobbled_deepslate|dirt|stone|andesite|diorite|granite|tuff)$/.test(i.name)
      )
    if (!item) return false
    const against = [
      floor.offset(0, -1, 0),
      floor.offset(1, 0, 0),
      floor.offset(-1, 0, 0),
      floor.offset(0, 0, 1),
      floor.offset(0, 0, -1),
    ]
      .map((p) => this.bot.blockAt(p))
      .find((b) => b && b.boundingBox === 'block')
    if (!against) return false
    try {
      await this.bot.equip(item, 'hand')
      await withTimeout(this.bot.placeBlock(against, floor.minus(against.position)), 8_000)
    } catch (err) {
      this.log.info(`could not bridge the hollow under step ${f}: ${errMsg(err)}`)
    }
    await sleep(300)
    if (!solid(floor)) return false
    this.log.info(`bridged a hollow under the stair at ${floor} with ${item.name}`)
    return true
  }

  private async digAt(p: Vec3): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const block = this.bot.blockAt(p)
      if (!block || /^(air|cave_air)$/.test(block.name) || block.name === 'torch') return
      // A pickaxe wears out (a wooden one after some sixty blocks): make another when it is gone.
      if ((STONE.test(block.name) || ORE.test(block.name)) && !this.hasPick()) await this.pickaxe()
      await this.toolFor(block.name)
      try {
        await withTimeout(this.bot.dig(block, true), 15_000)
        return
      } catch (err) {
        this.log.info(`could not dig ${block.name} at ${p} (try ${attempt + 1}): ${errMsg(err)}`)
        await sleep(300)
      }
    }
  }

  private hasPick(): boolean {
    return this.bot.inventory.items().some((i) => /_pickaxe$/.test(i.name))
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

  /**
   * Ores in the walls around the step, within reach: dug, and each vein followed through the
   * ore it opens up (as far as the pickaxe can, and the arm reaches).
   */
  private async oresAround(f: Vec3): Promise<number> {
    let taken = 0
    const eyes = () => this.bot.entity.position.offset(0, 1.62, 0)
    const queue: Vec3[] = []
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 2; dy++)
        for (let dz = -1; dz <= 1; dz++) queue.push(f.offset(dx, dy, dz))
    const seen = new Set<string>()
    while (queue.length && taken < VEIN && !this.cancelled) {
      const p = queue.shift() as Vec3
      const key = `${p.x},${p.y},${p.z}`
      if (seen.has(key)) continue
      seen.add(key)
      const name = this.names(p)
      if (!name || !ORE.test(name)) continue
      if (NEEDS_STONE_PICK.test(name) && this.count(/^(stone|iron)_pickaxe$/) === 0) continue
      if (NEEDS_IRON_PICK.test(name) && this.count(/^iron_pickaxe$/) === 0) {
        if (!this.goldLeft.has(key))
          this.log.info(`gold ore at ${p}: left, for want of an iron pickaxe`)
        this.goldLeft.add(key)
        continue
      }
      if (eyes().distanceTo(p.offset(0.5, 0.5, 0.5)) > REACH) continue
      await this.digAt(p)
      if (this.names(p) === name) continue
      taken++
      // The vein goes on through the ore next to this one.
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ])
        queue.push(p.offset(dx, dy, dz))
    }
    if (taken) {
      await sleep(500)
      this.log.info(`took ${taken} ore from the walls`)
    }
    return taken
  }

  /** A torch standing on a step (the one behind: the bot stands on this one). */
  private async torch(step: Vec3): Promise<void> {
    // None left: four from a lump of coal the mine gave (and a stick).
    if (this.count('torch') === 0 && this.count(/^(coal|charcoal)$/) > 0) {
      if (this.count('stick') === 0) await this.sticks().catch(() => {})
      if (this.count('stick') > 0) await craft(this.bot, this.log, 'torch', 1).catch(() => false)
    }
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
 * Where the court's mine starts: flat soil 10 to 24 blocks from home, away from the hall, the
 * field and the mines before it, with the ground running on the same way for a few steps (so
 * the stairs start in the open, not under a wall). Its stairs go NEW_DEPTH deep.
 */
export function chooseMine(
  names: (x: number, y: number, z: number) => string | undefined,
  home: { x: number; y: number; z: number },
  clear: Array<[number, number]>,
  depth = NEW_DEPTH
): Mine | undefined {
  const SOIL = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|stone|andesite|diorite|granite)$/
  // The forest floor too: leaf litter, bushes and the like (an oak wood's floor is all of
  // them: on 2026-11-04 a side found "no place near home" for a third mine).
  const OPEN =
    /^(air|short_grass|tall_grass|fern|large_fern|[a-z_]*flower|poppy|dandelion|leaf_litter|wildflowers|pink_petals|bush|firefly_bush|short_dry_grass|tall_dry_grass|dead_bush|deadbush|snow_layer|[a-z_]*_tulip|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley)$/
  // Out from home along the four ways, then to either side of each, further out as need be.
  const candidates: Array<[number, number, number, number]> = []
  for (let r = 10; r <= 40; r += 2)
    for (const side of [0, 4, -4, 8, -8])
      for (const [dx, dz] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ])
        if (r <= 24 || side === 0 || r % 4 === 0) candidates.push([r, side, dx, dz])
  candidates.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
  for (const [r, side, dx, dz] of candidates) {
    const x = home.x + dx * r - dz * side
    const z = home.z + dz * r + dx * side
    if (clear.some(([cx, cz]) => Math.abs(cx - x) <= 5 && Math.abs(cz - z) <= 5)) continue
    for (let y = home.y + 3; y >= home.y - 4; y--) {
      if (!SOIL.test(names(x, y - 1, z) ?? '') || !OPEN.test(names(x, y, z) ?? '')) continue
      if (!OPEN.test(names(x, y + 1, z) ?? '')) break
      // Going on outward, away from home.
      return { x, y, z, dx, dz, steps: 0, depth }
    }
  }
  return undefined
}

/**
 * An old mine record as it goes on now: one stopped "long enough" (before branches) or "deep
 * enough" branches off the tunnel it has; any other end means a new mine.
 */
export function mineGoesOn(mine: Mine): boolean {
  if (mine.ended === 'long enough' || mine.ended === 'deep enough') {
    mine.length = Math.max(mine.steps, depthOf(mine) + SHORT_LEVEL)
    mine.ended = undefined
  }
  return !mine.ended
}
