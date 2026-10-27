import { createRequire } from 'node:module'
import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep } from '../util'
import type { FillColumn, PlanCell, Vec } from './compile'
import type { Side } from './design'

/** Blocks the world grew by itself: these may be cleared off a building site. */
export const NATURAL =
  /^(sand|red_sand|gravel|dirt|coarse_dirt|grass_block|podzol|mycelium|clay|stone|sandstone|red_sandstone|andesite|diorite|granite|tuff|deepslate|snow|snow_layer|ice|moss_block|moss_carpet|[a-z_]*_leaves|[a-z_]*_log|short_grass|tall_grass|fern|large_fern|deadbush|dead_bush|vine|glow_lichen|sweet_berry_bush|bush|leaf_litter|firefly_bush|wildflowers|short_dry_grass|tall_dry_grass|poppy|dandelion|allium|cornflower|azure_bluet|oxeye_daisy|[a-z_]*_tulip|lily_of_the_valley|peony|rose_bush|lilac|sunflower|pink_petals|brown_mushroom|red_mushroom|sugar_cane|cactus)$/

const AIR = /^(air|cave_air|void_air)$/
const SOFT = /^(short_grass|tall_grass|fern|large_fern|deadbush|dead_bush|snow_layer|vine|glow_lichen|leaf_litter|short_dry_grass|tall_dry_grass|bush|wildflowers)$/
const LIQUID = /water|lava|bubble_column/

/** How far above a column's fill top natural blocks are cleared (trees included). */
const CLEAR_HEIGHT = 30
/** Deepest gap filled under a column. */
const FILL_DEPTH = 12
const REACH = 4.5

const SIDE_STEP: Record<Side, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
}

/** Neighbour directions to place against, below first (so slabs and carpets sit on the floor). */
const DIRECTIONS: Vec[] = [
  [0, -1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
]

export interface Job {
  id: string
  title: string
  cells: PlanCell[]
  columns: FillColumn[]
  /** Every block of the whole plan by "x,y,z", so clearing never removes planned work. */
  planned: Map<string, string>
}

export interface JobResult {
  placed: number
  dug: number
  /** Planned blocks still not in place afterwards. */
  missing: number
  /** Cells where something we may not break stands. */
  blocked: number
  cancelled: boolean
}

type Block = NonNullable<ReturnType<MineflayerBot['blockAt']>>
interface Target {
  x: number
  y: number
  z: number
  block: string
  data?: number
  against?: Vec
  from?: Side
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`
const floorVec = (p: { x: number; y: number; z: number }) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))

/**
 * Works through one section of a large plan like a creative-mode player: clears natural blocks
 * off the site, fills the ground up under it, then places every block bottom layer first,
 * flying to a spot beside each block. It never breaks anything a player built, except cells
 * marked `remove` (our own earlier work, such as a wall where a gate now goes).
 */
export class Mason {
  private readonly Item: new (type: number, count: number, metadata?: number) => unknown
  private cancelled = false
  private current: string | null = null
  private held: string | null = null
  /** The plan's blocks of the job in hand (what counts as our own work). */
  private planned = new Map<string, string>()

  constructor(
    private readonly bot: MineflayerBot,
    private readonly log: Logger
  ) {
    const req = createRequire(require.resolve('mineflayer-bedrock/package.json'))
    this.Item = (
      req('prismarine-item') as (registry: unknown) => new (t: number, c: number, m?: number) => unknown
    )(bot.registry)
  }

  get busy(): boolean {
    return this.current !== null
  }

  activity(): string | null {
    return this.current ? `building ${this.current}` : null
  }

  cancel(): void {
    if (this.current) this.cancelled = true
  }

  async work(job: Job): Promise<JobResult> {
    this.cancelled = false
    this.current = job.title
    this.planned = job.planned
    const result: JobResult = { placed: 0, dug: 0, missing: 0, blocked: 0, cancelled: false }
    try {
      await this.clear(job, result)
      if (!this.cancelled) await this.place(job, result)
    } catch (err) {
      this.log.warn(`${job.title}: ${errMsg(err)}`)
    } finally {
      result.cancelled = this.cancelled
      const left = this.countMissing(job)
      result.missing = left.missing
      result.blocked = left.blocked
      await this.land()
      this.current = null
    }
    this.log.info(
      `${job.title}: placed ${result.placed}, cleared ${result.dug}, missing ${result.missing}` +
        `${result.blocked ? `, blocked ${result.blocked}` : ''}${result.cancelled ? ' (stopped)' : ''}`
    )
    return result
  }

  /** Planned blocks not in place, and those where something a player made stands (left alone). */
  countMissing(job: Job): { missing: number; blocked: number } {
    let missing = 0
    let blocked = 0
    for (const c of job.cells) {
      const name = this.bot.blockAt(new Vec3(c.x, c.y, c.z))?.name
      if (c.block === 'air') {
        if (c.remove && name && !AIR.test(name)) missing++
      } else if (name !== c.block) {
        const foreign = name !== undefined && !AIR.test(name) && !SOFT.test(name) && !LIQUID.test(name) && !NATURAL.test(name)
        if (foreign) blocked++
        else missing++
      }
    }
    return { missing, blocked }
  }

  /** Dig natural blocks off the site (top down so sand never falls), and cells that must be empty. */
  private async clear(job: Job, result: JobResult): Promise<void> {
    const digs: Vec3[] = []
    const seen = new Set<string>()
    const want = (p: Vec3, block: Block) => {
      const k = key(p.x, p.y, p.z)
      if (seen.has(k)) return
      seen.add(k)
      if (job.planned.get(k) === block.name) return
      digs.push(p)
    }
    for (const col of job.columns) {
      for (let y = col.top + 1; y <= col.top + CLEAR_HEIGHT; y++) {
        const p = new Vec3(col.x, y, col.z)
        const block = this.bot.blockAt(p)
        if (block && NATURAL.test(block.name) && !SOFT.test(block.name)) want(p, block)
      }
    }
    for (const c of job.cells) {
      const p = new Vec3(c.x, c.y, c.z)
      const block = this.bot.blockAt(p)
      if (!block || AIR.test(block.name) || block.name === c.block) continue
      if (c.block === 'air' ? c.remove || NATURAL.test(block.name) : NATURAL.test(block.name) && !SOFT.test(block.name))
        want(p, block)
    }
    if (!digs.length) return
    this.log.info(`${job.title}: clearing ${digs.length} blocks`)
    digs.sort((a, b) => b.y - a.y)
    while (digs.length && !this.cancelled) {
      // Highest layer first; within it the nearest block.
      const me = this.bot.entity.position
      const layer = digs[0].y
      let best = 0
      for (let i = 1; i < digs.length && digs[i].y === layer; i++)
        if (digs[i].distanceTo(me) < digs[best].distanceTo(me)) best = i
      const [p] = digs.splice(best, 1)
      const block = this.bot.blockAt(p)
      if (!block || AIR.test(block.name) || LIQUID.test(block.name)) continue
      if (!(await this.reach({ x: p.x, y: p.y, z: p.z, block: 'air' }))) continue
      try {
        await withTimeout(this.bot.dig(block, true), 6_000)
        result.dug++
      } catch (err) {
        this.log.debug(`could not clear ${block.name} at ${p}: ${errMsg(err)}`)
      }
    }
  }

  /** Foundation fill and the plan's cells, lowest layer first. */
  private async place(job: Job, result: JobResult): Promise<void> {
    const todo: Target[] = []
    for (const col of job.columns) todo.push(...this.fillFor(col))
    for (const c of job.cells) if (c.block !== 'air' && !c.auto) todo.push(c)
    let waits = 0
    let skippedLayers = 0
    while (todo.length && !this.cancelled) {
      const me = this.bot.entity.position
      todo.sort((a, b) => a.y - b.y || dist(me, a) - dist(me, b))
      const layer = todo[0].y
      let index = -1
      let occupied = false
      for (let i = 0; i < todo.length && todo[i].y === layer; i++) {
        const t = todo[i]
        const existing = this.bot.blockAt(new Vec3(t.x, t.y, t.z))
        if (existing?.name === t.block) {
          index = i
          break
        }
        if (this.someoneIn(t)) {
          occupied = true
          continue
        }
        if (this.reference(t)) {
          index = i
          break
        }
      }
      if (index === -1) {
        if (occupied && waits++ < 10) {
          await sleep(1_000)
          continue
        }
        const stuck = todo.filter((t) => t.y === layer)
        skippedLayers++
        this.log.info(`${job.title}: ${stuck.length} blocks on layer ${layer} have nothing to stand on yet; skipping them`)
        for (const t of stuck) todo.splice(todo.indexOf(t), 1)
        continue
      }
      waits = 0
      const [t] = todo.splice(index, 1)
      const p = new Vec3(t.x, t.y, t.z)
      const existing = this.bot.blockAt(p)
      if (existing?.name === t.block) continue
      if (existing && !AIR.test(existing.name) && !SOFT.test(existing.name) && !LIQUID.test(existing.name)) {
        if (!NATURAL.test(existing.name)) {
          result.blocked++
          continue
        }
        // Natural ground in the way (left over from clearing): dig it first.
        if (await this.reach({ ...t, block: 'air' })) await withTimeout(this.bot.dig(existing, true), 6_000).catch(() => {})
      }
      if (await this.placeOne(t)) {
        result.placed++
        if (result.placed % 50 === 0) this.log.info(`${job.title}: ${result.placed} blocks placed, ${todo.length} to go`)
      }
    }
    if (skippedLayers) this.log.debug(`${job.title}: skipped ${skippedLayers} unsupported layers`)
  }

  /** Gaps under a column, from its top down to solid ground. */
  private fillFor(col: FillColumn): Target[] {
    const out: Target[] = []
    for (let y = col.top; y > col.top - FILL_DEPTH; y--) {
      const name = this.bot.blockAt(new Vec3(col.x, y, col.z))?.name
      if (name === undefined || LIQUID.test(name)) break
      if (!AIR.test(name) && !SOFT.test(name)) {
        // Solid: the top block may still need to change (paving over sand under an open floor).
        if (y === col.top && col.topMaterial && name !== col.topMaterial && NATURAL.test(name)) {
          out.push({ x: col.x, y, z: col.z, block: col.topMaterial })
        }
        break
      }
      out.push({ x: col.x, y, z: col.z, block: y === col.top ? (col.topMaterial ?? col.material) : col.material })
    }
    return out
  }

  private someoneIn(t: Target): boolean {
    for (const player of Object.values(this.bot.players)) {
      const e = player.entity
      if (!e || e === this.bot.entity) continue
      const p = e.position
      if (Math.abs(p.x - (t.x + 0.5)) < 0.8 && Math.abs(p.z - (t.z + 0.5)) < 0.8 && t.y >= Math.floor(p.y) - 0 && t.y <= Math.floor(p.y + 1.8))
        return true
    }
    return false
  }

  /** A solid neighbour to place against, and the face pointing from it to the target. */
  private reference(t: Target): { block: Block; face: Vec3 } | null {
    const dirs = t.against ? [t.against] : DIRECTIONS
    for (const [dx, dy, dz] of dirs) {
      const block = this.bot.blockAt(new Vec3(t.x + dx, t.y + dy, t.z + dz))
      if (block && block.boundingBox === 'block' && !LIQUID.test(block.name))
        return { block, face: new Vec3(-dx, -dy, -dz) }
    }
    return null
  }

  private async placeOne(t: Target, shaft = true): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await this.reach(t, attempt))) continue
      if (await this.putHere(t, attempt)) return true
    }
    // Still out of reach: probably inside a room that is already roofed over.
    return shaft && !this.cancelled ? this.viaShaft(t) : false
  }

  /** Place a block from where the bot is now. */
  private async putHere(t: Target, attempt = 0): Promise<boolean> {
    const p = new Vec3(t.x, t.y, t.z)
    const ref = this.reference(t)
    if (!ref) return false
    try {
      await this.hold(t.block, t.data)
      await withTimeout(this.bot.placeBlock(ref.block, ref.face), 5_000)
    } catch (err) {
      this.log.debug(`place ${t.block} at ${t.x},${t.y},${t.z} (try ${attempt + 1}): ${errMsg(err)}`)
    }
    for (let i = 0; i < 4; i++) {
      if (this.bot.blockAt(p)?.name === t.block) return true
      await sleep(120)
    }
    return false
  }

  /**
   * Last resort for a cell inside a finished room: lift a few of our own blocks straight above a
   * spot beside it (the roof), fly down the shaft, place the block, fly back up and put the
   * lifted blocks back. Never touches anything that is not planned work.
   */
  private async viaShaft(t: Target): Promise<boolean> {
    for (const spot of this.spotsFor(t).slice(0, 3)) {
      const sx = Math.floor(spot.x)
      const sz = Math.floor(spot.z)
      const sy = Math.floor(spot.y)
      const lifted: Target[] = []
      let open: number | undefined
      for (let y = sy + 2; y < sy + 30; y++) {
        const name = this.bot.blockAt(new Vec3(sx, y, sz))?.name
        if (name === undefined) break
        if (AIR.test(name) || SOFT.test(name)) {
          let sky = true
          for (let up = y; up < y + 12 && sky; up++) {
            const n = this.bot.blockAt(new Vec3(sx, up, sz))?.name
            if (n === undefined || !(AIR.test(n) || SOFT.test(n))) sky = false
          }
          if (sky) {
            open = y
            break
          }
          continue
        }
        if (this.planned.get(key(sx, y, sz)) !== name) break // not ours: leave it
        lifted.push({ x: sx, y, z: sz, block: name })
      }
      if (open === undefined || !lifted.length || lifted.length > 6) continue
      this.log.info(`reaching ${t.block} at ${t.x},${t.y},${t.z} through the roof (lifting ${lifted.length} blocks)`)
      const dug: Target[] = []
      try {
        for (const b of [...lifted].reverse()) {
          if (!(await this.reach({ ...b, block: 'air' }))) break
          const block = this.bot.blockAt(new Vec3(b.x, b.y, b.z))
          if (block) await withTimeout(this.bot.dig(block, true), 6_000)
          if (this.open(new Vec3(b.x, b.y, b.z))) dug.push(b)
        }
        if (dug.length !== lifted.length) continue
        await this.flyTo(new Vec3(sx + 0.5, open + 0.5, sz + 0.5))
        await this.flyTo(spot)
        const placed = await this.putHere(t)
        await this.flyTo(new Vec3(sx + 0.5, open + 0.5, sz + 0.5))
        return placed
      } catch (err) {
        this.log.debug(`shaft to ${t.x},${t.y},${t.z}: ${errMsg(err)}`)
      } finally {
        // Put the roof back, bottom up.
        for (const b of dug.sort((a, b) => a.y - b.y)) await this.placeOne(b, false)
      }
    }
    return false
  }

  /** Go and stand at a resting spot (between jobs), out of everyone's way. */
  async park(spot: { x: number; y: number; z: number }): Promise<void> {
    if (this.current) return
    this.current = 'going to rest'
    try {
      await this.flyTo(new Vec3(spot.x + 0.5, spot.y, spot.z + 0.5))
    } catch (err) {
      this.log.debug(`could not get to the resting spot: ${errMsg(err)}`)
    } finally {
      await this.land()
      this.current = null
    }
  }

  /** Get within reach of a cell (on the right side for facing blocks), flying as needed. */
  private async reach(t: Target, attempt = 0): Promise<boolean> {
    const center = new Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5)
    const eyes = () => this.bot.entity.position.offset(0, 1.62, 0)
    const feet = floorVec(this.bot.entity.position)
    const inTheWay = feet.x === t.x && feet.z === t.z && (feet.y === t.y || feet.y + 1 === t.y || feet.y - 1 === t.y)
    if (attempt === 0 && !inTheWay && eyes().distanceTo(center) <= REACH && this.rightSide(t)) return true
    const spots = this.spotsFor(t)
    for (const spot of spots.slice(0, 4 + attempt * 4)) {
      try {
        await this.flyTo(spot)
      } catch (err) {
        this.log.debug(`could not fly to ${spot}: ${errMsg(err)}`)
        continue
      }
      if (eyes().distanceTo(center) <= REACH + 0.5) return true
    }
    return eyes().distanceTo(center) <= REACH + 0.5 && !inTheWay
  }

  /** Facing blocks need the bot on their `from` side. */
  private rightSide(t: Target): boolean {
    if (!t.from) return true
    const [dx, dz] = SIDE_STEP[t.from]
    const p = this.bot.entity.position
    const ox = p.x - (t.x + 0.5)
    const oz = p.z - (t.z + 0.5)
    // Mostly on that side, and more along that axis than across it.
    return dx !== 0 ? Math.sign(ox) === dx && Math.abs(ox) > Math.abs(oz) + 0.5 : Math.sign(oz) === dz && Math.abs(oz) > Math.abs(ox) + 0.5
  }

  /** Free spots to hover at (feet positions), best first. */
  private spotsFor(t: Target): Vec3[] {
    const offsets: Array<[number, number, number]> = []
    if (t.from) {
      const [dx, dz] = SIDE_STEP[t.from]
      for (const d of [2, 3, 1]) for (const dy of [0, 1]) offsets.push([dx * d, dy, dz * d])
    } else if (t.against) {
      const [ax, , az] = t.against
      for (const d of [1, 2]) for (const dy of [0, 1, -1]) offsets.push([-ax * d, dy, -az * d])
      for (const s of [-1, 1]) offsets.push([-ax * 2 + (az !== 0 ? s : 0), 0, -az * 2 + (ax !== 0 ? s : 0)])
    } else {
      // Above the layer first: a bot never gets shut in under a ceiling it is building.
      for (const dy of [1, 0, 2, -1])
        for (const d of [2, 3])
          for (const [dx, dz] of [
            [d, 0],
            [-d, 0],
            [0, d],
            [0, -d],
            [d - 1, d - 1],
            [1 - d, d - 1],
            [d - 1, 1 - d],
            [1 - d, 1 - d],
          ])
            offsets.push([dx, dy, dz])
    }
    const me = this.bot.entity.position
    const out: Array<{ spot: Vec3; rank: number }> = []
    offsets.forEach(([dx, dy, dz], i) => {
      const cell = new Vec3(t.x + dx, t.y + dy, t.z + dz)
      if (!this.open(cell) || !this.open(cell.offset(0, 1, 0))) return
      const spot = cell.offset(0.5, 0, 0.5)
      // Keep the given order mostly, but prefer short flights.
      out.push({ spot, rank: i + spot.distanceTo(me) / 4 })
    })
    return out.sort((a, b) => a.rank - b.rank).map((o) => o.spot)
  }

  private open(cell: Vec3): boolean {
    const name = this.bot.blockAt(cell)?.name
    return name !== undefined && (AIR.test(name) || SOFT.test(name))
  }

  /** Fly in a straight line if the way is clear, otherwise up over whatever is in between. */
  private async flyTo(dest: Vec3): Promise<void> {
    const from = this.bot.entity.position.clone()
    if (from.distanceTo(dest) < 0.3) return
    if (this.clearLine(from, dest)) {
      await withTimeout(this.bot.creative.flyTo(dest), timeFor(from, dest))
      return
    }
    const cruise = this.cruiseHeight(from, dest)
    const up = new Vec3(from.x, cruise, from.z)
    const over = new Vec3(dest.x, cruise, dest.z)
    if (!this.clearLine(from, up)) {
      // Something overhead (we are under a roof): try to get out sideways towards the target.
      await withTimeout(this.bot.creative.flyTo(dest), timeFor(from, dest))
      return
    }
    await withTimeout(this.bot.creative.flyTo(up), timeFor(from, up))
    await withTimeout(this.bot.creative.flyTo(over), timeFor(up, over))
    await withTimeout(this.bot.creative.flyTo(dest), timeFor(over, dest))
  }

  /** No solid block in the way of a body (0.6 wide, 1.8 tall) moving from a to b. */
  private clearLine(a: Vec3, b: Vec3): boolean {
    const length = a.distanceTo(b)
    const steps = Math.max(1, Math.ceil(length / 0.4))
    for (let i = 0; i <= steps; i++) {
      const p = a.plus(b.minus(a).scaled(i / steps))
      for (const dy of [0.1, 0.9, 1.7])
        for (const [dx, dz] of [
          [-0.3, -0.3],
          [0.3, -0.3],
          [-0.3, 0.3],
          [0.3, 0.3],
        ]) {
          const name = this.bot.blockAt(new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz)))?.name
          if (name === undefined || !(AIR.test(name) || SOFT.test(name))) return false
        }
    }
    return true
  }

  /** Height that clears every block between two points (seen from above), plus room to spare. */
  private cruiseHeight(a: Vec3, b: Vec3): number {
    let top = Math.max(a.y, b.y)
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    const steps = Math.max(1, Math.ceil(length / 0.5))
    for (let i = 0; i <= steps; i++) {
      const x = Math.floor(a.x + ((b.x - a.x) * i) / steps)
      const z = Math.floor(a.z + ((b.z - a.z) * i) / steps)
      for (const [dx, dz] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        for (let y = Math.ceil(Math.max(a.y, b.y)) + 40; y > top; y--) {
          const name = this.bot.blockAt(new Vec3(x + dx, y, z + dz))?.name
          if (name && !(AIR.test(name) || SOFT.test(name))) {
            top = y + 1
            break
          }
        }
      }
    }
    return Math.ceil(top) + 1.2
  }

  private async hold(block: string, data?: number): Promise<void> {
    const want = `${block}:${data ?? 0}`
    if (this.held === want && this.bot.heldItem?.name === block) return
    const info = this.bot.registry.itemsByName[block] as { id: number; stackSize?: number } | undefined
    if (info === undefined) throw new Error(`no item called ${block}`)
    // Beds and cakes stack to one: the server refuses a creative stack bigger than the item allows.
    const count = Math.max(1, Math.min(64, info.stackSize ?? 64))
    await this.bot.creative.setInventorySlot(36, new this.Item(info.id, count, data ?? 0) as never)
    this.bot.setQuickBarSlot(0)
    this.held = want
  }

  private async land(): Promise<void> {
    try {
      if ((this.bot.entity as unknown as { flying?: boolean })?.flying) this.bot.creative.stopFlying()
    } catch {
      // not flying
    }
  }
}

function dist(a: Vec3, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x - 0.5, a.y - b.y, a.z - b.z - 0.5)
}

function timeFor(a: Vec3, b: Vec3): number {
  return 4_000 + a.distanceTo(b) * 400
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ])
}
