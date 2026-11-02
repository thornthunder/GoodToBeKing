import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { NATURAL } from '../build/Mason'
import type { Logger } from '../logger'
import { errMsg, withTimeout } from '../util'

/**
 * Out of a hole. A courtier that wakes in a creeper's crater, or walks into a pit, with no way
 * up digs itself steps, one block up at a time, towards where it wants to go. Only natural
 * blocks are dug, never anything made, so a wall stops it. On 2026-11-02 the whole Blue side of
 * the war game stood four blocks down in a crater under its own spawn point for three hours,
 * killed over and over by the zombie villager down there with them, and every job it was given
 * ended in "No path to the goal".
 */

/** Air and what a player walks through. */
const OPEN =
  /^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow_layer|torch|wall_torch|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip)$/
/** Steps dug at most, in one climb. */
const MAX_STEPS = 8
/** Digging stone by hand takes seven seconds and a half. */
const DIG_MS = 20_000
const STEP_MS = 10_000
const STONE = /stone|deepslate|andesite|diorite|granite|tuff/

export type Names = (x: number, y: number, z: number) => string | undefined

export interface Step {
  /** Where the feet stand after the step. */
  stand: Vec3
  /** Blocks dug first. */
  dig: Vec3[]
}

const open = (n: string | undefined) => n !== undefined && OPEN.test(n)
const natural = (n: string | undefined) => n !== undefined && NATURAL.test(n)

/**
 * One step from `at` (the feet) in direction `dir` (a unit step along x or z): up onto the
 * block there when one stands at feet height, else along the level ground. The two blocks
 * where the body goes, and the one over the head here (room to jump), are dug when they are
 * natural. Null when a block in the way is made or unknown, or the ground drops away that way.
 */
export function planStep(names: Names, at: Vec3, dir: { x: number; z: number }): Step | null {
  const [x, z] = [at.x + dir.x, at.z + dir.z]
  const up = !open(names(x, at.y, z))
  if (!up && open(names(x, at.y - 1, z))) return null
  const y = up ? at.y + 1 : at.y
  const room = up
    ? [new Vec3(at.x, at.y + 2, at.z), new Vec3(x, y, z), new Vec3(x, y + 1, z)]
    : [new Vec3(x, y, z), new Vec3(x, y + 1, z)]
  const dig: Vec3[] = []
  for (const p of room) {
    const n = names(p.x, p.y, p.z)
    if (open(n)) continue
    if (!natural(n)) return null
    dig.push(p)
  }
  return { stand: new Vec3(x, y, z), dig }
}

/** The four ways to go, the one most towards `toward` first. */
export function directions(
  from: Vec3,
  toward: { x: number; z: number }
): Array<{ x: number; z: number }> {
  const dx = toward.x - from.x
  const dz = toward.z - from.z
  const sx = dx >= 0 ? 1 : -1
  const sz = dz >= 0 ? 1 : -1
  return Math.abs(dx) >= Math.abs(dz)
    ? [
        { x: sx, z: 0 },
        { x: 0, z: sz },
        { x: 0, z: -sz },
        { x: -sx, z: 0 },
      ]
    : [
        { x: 0, z: sz },
        { x: sx, z: 0 },
        { x: -sx, z: 0 },
        { x: 0, z: -sz },
      ]
}

type Walker = MineflayerBot & { pathfinder: Pathfinder }

/** Is there no way at all from here to the goal (the search runs out within one think)? */
export function noWay(bot: MineflayerBot, goal: goals.Goal): boolean {
  const walker = bot as Walker
  try {
    return walker.pathfinder.getPathTo(walker.pathfinder.movements, goal, 500).status === 'noPath'
  } catch {
    return false
  }
}

/**
 * Dig and climb towards `toward` until a way to `goal` is found, or the steps run out, or a
 * made block bars every way. Returns the steps climbed when a way to the goal is open now
 * (0: there was one all along), -1 when there is none.
 */
export async function climbOut(
  bot: MineflayerBot,
  log: Logger,
  toward: { x: number; z: number },
  goal: goals.Goal
): Promise<number> {
  const walker = bot as Walker
  const names: Names = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name
  let climbed = 0
  let failed = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    if (!noWay(bot, goal)) {
      if (climbed) log.info(`climbed ${climbed} step(s) out of the hole`)
      return climbed
    }
    const at = bot.entity.position.floored()
    let step: Step | null = null
    for (const dir of directions(at, toward)) {
      step = planStep(names, at, dir)
      if (step) break
    }
    if (!step) {
      log.info(`no way up out of the hole at ${at}: walls all round`)
      return -1
    }
    try {
      for (const p of step.dig) {
        const block = bot.blockAt(p)
        if (!block || open(block.name)) continue
        await equipFor(bot, block.name)
        await withTimeout(bot.dig(block, true), DIG_MS)
      }
      const s = step.stand
      await withTimeout(walker.pathfinder.goto(new goals.GoalBlock(s.x, s.y, s.z)), STEP_MS)
      if (s.y > at.y) climbed++
    } catch (err) {
      walker.pathfinder.setGoal(null)
      log.info(`a step out of the hole failed: ${errMsg(err)}`)
      if (++failed >= 2) return -1
    }
  }
  return noWay(bot, goal) ? -1 : climbed
}

/** A pickaxe for stone, a shovel for earth, when there is one; else the hand. */
async function equipFor(bot: MineflayerBot, block: string): Promise<void> {
  const want = STONE.test(block) ? /_pickaxe$/ : /_shovel$/
  const tool = bot.inventory.items().find((i) => want.test(i.name))
  if (tool) await bot.equip(tool, 'hand').catch(() => {})
}
