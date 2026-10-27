import { createRequire } from 'node:module'
import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep } from '../util'
import type { BuildLog, PlacedBlock } from './BuildLog'
import type { BlockKind, Point, Site, WorldView } from './site'

const AIR = new Set(['air', 'cave_air', 'void_air'])
const REPLACEABLE = new Set([
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'deadbush',
  'dead_bush',
  'snow_layer',
])
const SOIL = new Set([
  'grass_block',
  'dirt',
  'coarse_dirt',
  'podzol',
  'rooted_dirt',
  'moss_block',
  'mycelium',
])
/** Blocks we never build on or into, even though they are full blocks. */
const NOT_GROUND =
  /leaves|_log$|_wood$|_stem$|hyphae|water|lava|chest|barrel|shulker|door|bed$|sign|furnace|hopper/

/** Blocks within this distance of the eyes are placed without moving (Bedrock reach is ~5). */
const REACH = 4.5

type BuilderBot = MineflayerBot & { pathfinder: Pathfinder }
type Block = NonNullable<ReturnType<MineflayerBot['blockAt']>>

export interface BuildResult {
  title: string
  requestedBy: string
  ok: boolean
  placed: number
  total: number
  skipped: number
  reason?: 'cancelled' | 'stuck'
  origin: Point
}

/** One block placement step: where, what, and the six neighbour directions to lean on. */
const DIRECTIONS: Array<[number, number, number]> = [
  [0, -1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
]

/**
 * Builds a blueprint at a site, block by block, like a player in creative mode: takes the block
 * from the creative inventory, walks (or, as a last resort, flies) within reach, and places it
 * against a solid neighbour. Never breaks anything except, on undo, blocks it placed itself.
 */
export class Builder {
  private readonly bot: BuilderBot
  private readonly Item: new (type: number, count: number) => unknown
  private cancelled = false
  private current: { title: string; requestedBy: string } | null = null
  private held: string | null = null

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly record: BuildLog,
    private readonly botName: string
  ) {
    this.bot = bot as BuilderBot
    // prismarine-item is a dependency of mineflayer-bedrock, not of this project.
    const req = createRequire(require.resolve('mineflayer-bedrock/package.json'))
    this.Item = (
      req('prismarine-item') as (registry: unknown) => new (t: number, c: number) => unknown
    )(bot.registry)
  }

  get busy(): boolean {
    return this.current !== null
  }

  /** e.g. "building a simple castle"; null when idle. */
  activity(): string | null {
    return this.current ? `building ${this.current.title} for ${this.current.requestedBy}` : null
  }

  cancel(): void {
    if (this.current) this.cancelled = true
  }

  /** The world as the site finder sees it. */
  world(): WorldView {
    return { kind: (x, y, z) => this.kindAt(new Vec3(x, y, z)) }
  }

  private kindAt(pos: Vec3): BlockKind | undefined {
    const block = this.bot.blockAt(pos)
    if (!block) return undefined
    if (AIR.has(block.name)) return 'air'
    if (REPLACEABLE.has(block.name)) return 'replaceable'
    if (NOT_GROUND.test(block.name)) return 'other'
    if (SOIL.has(block.name)) return 'soil'
    return block.boundingBox === 'block' ? 'solid' : 'other'
  }

  async build(
    site: Site,
    opts: { title: string; blueprint: string; requestedBy: string; foundation: string }
  ): Promise<BuildResult> {
    this.cancelled = false
    this.current = { title: opts.title, requestedBy: opts.requestedBy }
    const { origin } = site
    const todo: PlacedBlock[] = [
      ...site.fill.map((p) => ({ ...p, block: opts.foundation })),
      ...site.blueprint.cells.map((c) => ({
        x: origin.x + c.x,
        y: origin.y + c.y,
        z: origin.z + c.z,
        block: c.block,
      })),
    ]
    const total = todo.length
    const placed: PlacedBlock[] = []
    let skipped = 0
    let reason: BuildResult['reason']
    this.log.info(`building ${opts.title} at ${origin.x},${origin.y},${origin.z}: ${total} blocks`)

    try {
      while (todo.length > 0) {
        if (this.cancelled) {
          reason = 'cancelled'
          break
        }
        // Lowest layer first; within it the nearest block that already has something to lean on.
        const me = this.bot.entity.position
        todo.sort((a, b) => a.y - b.y || dist(me, a) - dist(me, b))
        const index = todo.findIndex((t) => t.y === todo[0].y && this.reference(t) !== null)
        if (index === -1) {
          // Nothing on this layer can be placed (no support): skip the layer's leftovers.
          const layer = todo[0].y
          const stuck = todo.filter((t) => t.y === layer)
          skipped += stuck.length
          this.log.warn(`skipping ${stuck.length} unsupported blocks on layer ${layer}`)
          for (const t of stuck) todo.splice(todo.indexOf(t), 1)
          continue
        }
        const [target] = todo.splice(index, 1)
        const existing = this.bot.blockAt(vec(target))
        if (existing?.name === target.block) continue // already there (e.g. a resumed build)
        const kind = this.kindAt(vec(target))
        if (kind !== 'air' && kind !== 'replaceable') {
          skipped++
          continue
        }
        if (await this.place(target)) {
          placed.push(target)
          if (placed.length % 25 === 0)
            this.log.info(`${opts.title}: ${placed.length}/${total} blocks`)
        } else {
          skipped++
        }
        if (skipped > Math.max(10, total * 0.3)) {
          reason = 'stuck'
          break
        }
      }
    } finally {
      await this.land()
      this.record.add({
        bot: this.botName,
        blueprint: opts.blueprint,
        title: opts.title,
        requestedBy: opts.requestedBy,
        origin,
        finishedAt: Date.now(),
        placed,
      })
      this.current = null
    }
    const ok = !reason && skipped <= total * 0.1
    this.log.info(
      `${opts.title}: placed ${placed.length}/${total}, skipped ${skipped}${reason ? `, ${reason}` : ''}`
    )
    return {
      title: opts.title,
      requestedBy: opts.requestedBy,
      ok,
      placed: placed.length,
      total,
      skipped,
      reason,
      origin,
    }
  }

  /** Remove the blocks of this bot's most recent build (only those still in place). */
  async undoLast(): Promise<{ title: string; removed: number } | null> {
    const last = this.record.last(this.botName)
    if (!last) return null
    this.current = { title: `taking down ${last.title}`, requestedBy: last.requestedBy }
    let removed = 0
    try {
      for (const p of [...last.placed].reverse()) {
        const block = this.bot.blockAt(vec(p))
        if (block?.name !== p.block) continue
        if (!(await this.reach(p))) continue
        try {
          await this.bot.dig(block, true)
          removed++
        } catch (err) {
          this.log.debug(`could not remove ${p.block} at ${p.x},${p.y},${p.z}: ${errMsg(err)}`)
        }
      }
    } finally {
      await this.land()
      this.record.remove(last)
      this.current = null
    }
    this.log.info(`took down ${last.title}: removed ${removed}/${last.placed.length}`)
    return { title: last.title, removed }
  }

  /** A solid neighbour to place against, and the face pointing from it to the target. */
  private reference(t: Point): { block: Block; face: Vec3 } | null {
    for (const [dx, dy, dz] of DIRECTIONS) {
      const block = this.bot.blockAt(new Vec3(t.x + dx, t.y + dy, t.z + dz))
      if (block && block.boundingBox === 'block') return { block, face: new Vec3(-dx, -dy, -dz) }
    }
    return null
  }

  private async place(t: PlacedBlock): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await this.reach(t, attempt))) continue
      const ref = this.reference(t)
      if (!ref) return false
      try {
        await this.hold(t.block)
        await withTimeout(this.bot.placeBlock(ref.block, ref.face), 5_000)
      } catch (err) {
        this.log.debug(
          `place ${t.block} at ${t.x},${t.y},${t.z} (try ${attempt + 1}): ${errMsg(err)}`
        )
      }
      for (let i = 0; i < 4; i++) {
        if (this.bot.blockAt(vec(t))?.name === t.block) return true
        await sleep(150)
      }
    }
    return false
  }

  /** Get within reach of a block without standing in it. Walk first; fly when walking fails. */
  private async reach(t: Point, attempt = 0): Promise<boolean> {
    const center = new Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5)
    const eyes = this.bot.entity.position.offset(0, 1.62, 0)
    const feet = this.bot.entity.position.floored()
    const inTheWay = feet.x === t.x && feet.z === t.z && (feet.y === t.y || feet.y + 1 === t.y)
    if (!inTheWay && eyes.distanceTo(center) <= REACH && attempt === 0) return true
    try {
      if (attempt < 2) {
        const goal = new goals.GoalNear(t.x, t.y, t.z, attempt === 0 ? 3 : 2)
        await withTimeout(this.bot.pathfinder.goto(goal), 12_000)
      } else {
        // Last resort for high blocks: creative flight to a free spot beside the target.
        const spot = this.besideInAir(t)
        if (!spot) return false
        await withTimeout(this.bot.creative.flyTo(spot), 12_000)
      }
    } catch (err) {
      this.log.debug(`could not get near ${t.x},${t.y},${t.z}: ${errMsg(err)}`)
    }
    const here = this.bot.entity.position.offset(0, 1.62, 0)
    return here.distanceTo(center) <= REACH + 1
  }

  /** A free cell two blocks out from the target, at the target's height. */
  private besideInAir(t: Point): Vec3 | null {
    for (const [dx, dz] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ]) {
      const spot = new Vec3(t.x + dx + 0.5, t.y, t.z + dz + 0.5)
      if (
        this.kindAt(spot.floored()) === 'air' &&
        this.kindAt(spot.floored().offset(0, 1, 0)) === 'air'
      )
        return spot
    }
    return null
  }

  /** Put the block in hotbar slot 1 from the creative inventory and select it. */
  private async hold(block: string): Promise<void> {
    if (this.held === block && this.bot.heldItem?.name === block) return
    const id = this.bot.registry.itemsByName[block]?.id
    if (id === undefined) throw new Error(`no item called ${block}`)
    await this.bot.creative.setInventorySlot(36, new this.Item(id, 64) as never)
    this.bot.setQuickBarSlot(0)
    this.held = block
  }

  /** Stop flying (if we were) so the bot stands on the ground again. */
  private async land(): Promise<void> {
    try {
      if ((this.bot.entity as unknown as { flying?: boolean })?.flying)
        this.bot.creative.stopFlying()
    } catch {
      // not flying
    }
  }
}

function vec(p: Point): Vec3 {
  return new Vec3(p.x, p.y, p.z)
}

function dist(a: Vec3, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    ),
  ])
}
