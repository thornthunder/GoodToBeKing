import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { NATURAL } from '../build/Mason'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'

/**
 * Out of a hole. A courtier that wakes in a creeper's crater, or walks into a pit, with no way
 * up digs itself steps, one block up at a time, towards where it wants to go. Natural blocks
 * are dug freely; a made block only when the courtier can put it back, and it is put back as
 * soon as a way is found (the King's rule, 2026-11-03: "you're allowed to break it as long as
 * you remake it the way you found it"). On 2026-11-02 the whole Blue side of the war game stood
 * four blocks down in a crater under its own spawn point for three hours, killed over and over
 * by the zombie villager down there with them, and every job it was given ended in "No path to
 * the goal"; the next night a bot sat in a one-block shaft its own hall repair had filled round
 * it with planks, until it died.
 */

/** Air and what a player walks through. */
const OPEN =
  /^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow_layer|torch|wall_torch|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip)$/
/** Steps dug at most, in one climb. */
const MAX_STEPS = 8
/** Digging stone by hand takes seven seconds and a half. */
const DIG_MS = 20_000
const STEP_MS = 10_000
const PLACE_MS = 8_000
const STONE = /stone|deepslate|andesite|diorite|granite|tuff|brick|concrete|terracotta/
/** Made blocks that drop themselves to the bare hand. */
const SELF_DROP =
  /_planks$|_log$|_wood$|_wool$|^(dirt|coarse_dirt|sand|red_sand|gravel|clay|hay_block|crafting_table|chest|bookshelf|[a-z_]*_fence|[a-z_]*_slab|[a-z_]*_stairs)$/
/** Made blocks that drop themselves to a pickaxe (stone drops cobblestone: not itself). */
const WITH_PICKAXE =
  /^(cobblestone|mossy_cobblestone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|cobbled_deepslate|deepslate_bricks|deepslate_tiles|bricks|sandstone|red_sandstone|smooth_stone|smooth_sandstone|polished_[a-z_]+|[a-z_]*_concrete|terracotta|[a-z_]*_terracotta|quartz_block|nether_bricks|blackstone|basalt|[a-z_]*_wall)$/

export type Names = (x: number, y: number, z: number) => string | undefined
/** Whether a block in the way may be dug. */
export type MayDig = (name: string) => boolean

export interface Step {
  /** Where the feet stand after the step. */
  stand: Vec3
  /** Blocks dug first. */
  dig: Vec3[]
}

const open = (n: string | undefined) => n !== undefined && OPEN.test(n)
export const natural: MayDig = (n) => NATURAL.test(n)

/**
 * Can a made block be put back as found after digging it: one is carried already, or digging
 * it yields it (planks to the hand, cobblestone to a pickaxe)?
 */
export function canRestore(held: string[], block: string): boolean {
  if (held.includes(block) || SELF_DROP.test(block)) return true
  return WITH_PICKAXE.test(block) && held.some((n) => /_pickaxe$/.test(n))
}

/**
 * One step from `at` (the feet) in direction `dir` (a unit step along x or z): up onto the
 * block there when one stands at feet height, else along the level ground. The two blocks
 * where the body goes, and the one over the head here (room to jump), are dug when `mayDig`
 * allows (natural blocks by default). Null when a block in the way may not be dug or is
 * unknown, or the ground drops away that way.
 */
export function planStep(
  names: Names,
  at: Vec3,
  dir: { x: number; z: number },
  mayDig: MayDig = natural
): Step | null {
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
    if (n === undefined || !mayDig(n)) return null
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

/** The search for a way is given this long; a sealed room runs out of nodes well within it. */
const NO_WAY_MS = 600

/**
 * Is there no way at all from here to the goal: the search runs out of nodes within a short
 * while? The pathfinder searches a tick (40 ms) at a time and answers "partial" between ticks,
 * so the ticks are run on until it is sure or the time is up (on 2026-11-03 one tick was not
 * always enough for a hall of seven by seven, and raiders stood in a crater without climbing).
 */
export function noWay(bot: MineflayerBot, goal: goals.Goal): boolean {
  const walker = bot as Walker & {
    pathfinder: {
      getPathFromTo?: (
        movements: unknown,
        from: Vec3,
        goal: goals.Goal,
        options: { timeout: number }
      ) => Iterable<{ result: { status: string } }>
    }
  }
  try {
    const search = walker.pathfinder.getPathFromTo
    if (!search) {
      return (
        walker.pathfinder.getPathTo(walker.pathfinder.movements, goal, NO_WAY_MS).status ===
        'noPath'
      )
    }
    const started = Date.now()
    let status = 'partial'
    for (const step of search.call(
      walker.pathfinder,
      walker.pathfinder.movements,
      bot.entity.position,
      goal,
      { timeout: NO_WAY_MS }
    )) {
      status = step.result.status
      if (status !== 'partial' || Date.now() - started > NO_WAY_MS) break
    }
    return status === 'noPath'
  } catch {
    return false
  }
}

interface Borrowed {
  pos: Vec3
  name: string
}

/**
 * Dig and climb towards `toward` until a way to `goal` is found, or the steps run out, or a
 * block that may not be dug bars every way; then put back every made block dug. Returns the
 * steps climbed when a way to the goal is open now (0: there was one all along), -1 when
 * there is none.
 */
export async function climbOut(
  bot: MineflayerBot,
  log: Logger,
  toward: { x: number; z: number },
  goal: goals.Goal
): Promise<number> {
  const borrowed: Borrowed[] = []
  let lastDir = directions(bot.entity.position.floored(), toward)[0]
  const held = () => bot.inventory.items().map((i) => i.name)
  const mayDig: MayDig = (n) => natural(n) || canRestore(held(), n)
  const result = await climb(bot, log, toward, goal, mayDig, borrowed, (d) => (lastDir = d))
  if (borrowed.length) await putBack(bot, log, borrowed, lastDir)
  return result
}

async function climb(
  bot: MineflayerBot,
  log: Logger,
  toward: { x: number; z: number },
  goal: goals.Goal,
  mayDig: MayDig,
  borrowed: Borrowed[],
  stepped: (dir: { x: number; z: number }) => void
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
    let dir = directions(at, toward)[0]
    for (dir of directions(at, toward)) {
      step = planStep(names, at, dir, mayDig)
      if (step) break
    }
    if (!step) {
      log.info(`no way up out of the hole at ${at}: walls all round`)
      return -1
    }
    stepped(dir)
    try {
      for (const p of step.dig) {
        const block = bot.blockAt(p)
        if (!block || open(block.name)) continue
        const made = !natural(block.name)
        await equipFor(bot, block.name)
        await withTimeout(bot.dig(block, true), DIG_MS)
        if (made) {
          borrowed.push({ pos: p.clone(), name: block.name })
          log.info(`borrowed a ${block.name} at ${p} to get out; it goes back after`)
        }
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

/** Every made block dug on the way out goes back as it was, the last dug first. */
async function putBack(
  bot: MineflayerBot,
  log: Logger,
  borrowed: Borrowed[],
  lastDir: { x: number; z: number }
): Promise<void> {
  const walker = bot as Walker
  // Out of the way first: the last cells dug are where the body stands.
  const clear = bot.entity.position.floored().offset(lastDir.x, 0, lastDir.z)
  await withTimeout(
    walker.pathfinder.goto(new goals.GoalNear(clear.x, clear.y, clear.z, 1)),
    STEP_MS
  ).catch(() => walker.pathfinder.setGoal(null))
  await sleep(500)
  for (const { pos, name } of [...borrowed].reverse()) {
    const now = bot.blockAt(pos)
    if (!now || !open(now.name)) continue
    const item = bot.inventory.items().find((i) => i.name === name)
    if (!item) {
      log.info(`cannot put the ${name} back at ${pos}: none in hand`)
      continue
    }
    const me = bot.entity.position.floored()
    if (pos.equals(me) || pos.equals(me.offset(0, 1, 0))) {
      log.info(`cannot put the ${name} back at ${pos}: standing in it`)
      continue
    }
    const against = [
      pos.offset(0, -1, 0),
      pos.offset(1, 0, 0),
      pos.offset(-1, 0, 0),
      pos.offset(0, 0, 1),
      pos.offset(0, 0, -1),
      pos.offset(0, 1, 0),
    ]
      .map((p) => bot.blockAt(p))
      .find((b) => b && b.boundingBox === 'block')
    if (!against) {
      log.info(`cannot put the ${name} back at ${pos}: nothing to place it against`)
      continue
    }
    try {
      if (bot.entity.position.distanceTo(pos) > 4)
        await withTimeout(
          walker.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
          STEP_MS
        ).catch(() => walker.pathfinder.setGoal(null))
      await bot.equip(item, 'hand')
      await withTimeout(bot.placeBlock(against, pos.minus(against.position)), PLACE_MS)
      log.info(`put the ${name} back at ${pos}`)
    } catch (err) {
      log.info(`could not put the ${name} back at ${pos}: ${errMsg(err)}`)
    }
  }
}

/** A pickaxe for stone, a shovel for earth, when there is one; else the hand. */
async function equipFor(bot: MineflayerBot, block: string): Promise<void> {
  const want = STONE.test(block) ? /_pickaxe$/ : /_shovel$/
  const tool = bot.inventory.items().find((i) => want.test(i.name))
  if (tool) await bot.equip(tool, 'hand').catch(() => {})
}
