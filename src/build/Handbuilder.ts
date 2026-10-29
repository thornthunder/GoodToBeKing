import type { Chest, Bot as MineflayerBot } from 'mineflayer-bedrock'
import { Movements, goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { craft } from '../bot/crafting'
import type { Gatherer } from '../bot/gathering'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import type { HandCell } from './hall'

/** Groups a cell may ask for: any member will do ("planks" = oak, birch or spruce planks). */
const GROUPS: Record<string, RegExp> = {
  planks: /_planks$/,
  log: /_log$/,
  // Any stone a mine gives: cobblestone, andesite, diorite, granite...
  stone: /^(cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|stone)$/,
  // Whatever closes a hole, sturdiest first (see FILLER_ORDER).
  filler: /(_planks|^cobblestone|^dirt)$/,
}
/** Filler by preference: planks and stone keep endermen and creepers out better than dirt. */
const FILLER_ORDER = [/_planks$/, /^cobblestone$/, /^dirt$/]
export const itemsFor = (block: string): RegExp => GROUPS[block] ?? new RegExp(`^${block}$`)

/** Blocks a builder towers up on when a spot is out of reach, and takes away afterwards. */
const SCAFFOLD = /^(dirt|cobblestone)$/
/** What a block may be placed into. */
const ROOM =
  /^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow_layer|leaf_litter|wildflowers|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip)$/
const LIQUID = /^(flowing_)?(water|lava)$/
/** Reach for placing, from the eyes (Bedrock's is a little longer). */
const REACH = 4.5
/** Neighbours to place against, below first. */
const DIRECTIONS: Array<[number, number, number]> = [
  [0, -1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
]

type BuildBot = MineflayerBot & { pathfinder: Pathfinder }
type Block = NonNullable<ReturnType<MineflayerBot['blockAt']>>

export interface HandJob {
  title: string
  cells: HandCell[]
}

export interface HandResult {
  placed: number
  /** Cells still not as planned afterwards. */
  missing: number
  /** What there was not enough of, by group or block. */
  short: Record<string, number>
  cancelled: boolean
}

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`

/**
 * Builds like a survival player: materials from the storehouse (planks made from logs, more wood
 * chopped when short), every block placed from where the builder can stand, towering up on dirt
 * when a spot is out of reach, and the scaffolding taken away afterwards.
 */
export class Handbuilder {
  private readonly bot: BuildBot
  private current: string | null = null
  private cancelled = false

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly gatherer: Gatherer,
    /** Put the everyday walking rules back (no towering, no world changes). */
    private readonly afterwards: () => void
  ) {
    this.bot = bot as BuildBot
  }

  get busy(): boolean {
    return this.current !== null
  }

  activity(): string | null {
    return this.current ? `building ${this.current} by hand` : null
  }

  cancel(): void {
    if (!this.current) return
    this.cancelled = true
    this.gatherer.cancel()
    this.bot.pathfinder.setGoal(null)
  }

  async build(job: HandJob, storehouse?: { x: number; y: number; z: number }): Promise<HandResult> {
    const result: HandResult = { placed: 0, missing: 0, short: {}, cancelled: false }
    if (this.current) return { ...result, cancelled: true }
    this.current = job.title
    this.cancelled = false
    const planned = new Set(job.cells.map(key))
    // Whatever the builder places that is not in the plan is scaffolding (towers, bridges).
    const scaffold: Vec3[] = []
    const onPlaced = (_old: unknown, block: { position?: Vec3 } | null) => {
      const p = block?.position
      if (p && !planned.has(key(p))) scaffold.push(p.clone())
    }
    const events = this.bot as unknown as NodeJS.EventEmitter
    events.on('blockPlaced', onPlaced)
    try {
      this.useBuildingRules(true)
      await this.getMaterials(job, storehouse)
      if (!this.cancelled) await this.placeAll(job, result)
      this.useBuildingRules(false)
      await this.clearScaffold(scaffold)
      // What is missing, and short, before the leftovers go back.
      this.tally(job, result)
      if (storehouse && !this.cancelled) await this.putBack(storehouse)
    } catch (err) {
      this.log.warn(`${job.title}: ${errMsg(err)}`)
    } finally {
      events.removeListener('blockPlaced', onPlaced)
      this.current = null
      this.afterwards()
    }
    result.cancelled = this.cancelled
    this.log.info(
      `${job.title}: placed ${result.placed}, ${result.missing} missing` +
        (Object.keys(result.short).length ? `, short of ${JSON.stringify(result.short)}` : '')
    )
    return result
  }

  /** Cells not as planned, and those for want of material. */
  private tally(job: HandJob, result: HandResult): void {
    result.missing = job.cells.filter((c) => !this.inPlace(c)).length
    result.short = {}
    for (const c of job.cells)
      if (!this.inPlace(c) && this.carried(c.block) === 0)
        result.short[c.block] = (result.short[c.block] ?? 0) + 1
  }

  /** Walking rules while building: tower up on dirt or cobblestone, never dig a way through. */
  private useBuildingRules(tower: boolean): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const movements = new Movements(this.bot as any)
    movements.canDig = false
    movements.allowParkour = false
    // Builders work in survival only, where the hall has a door to get in and out by.
    movements.canOpenDoors = true
    // No drop that hurts (more than three blocks costs health).
    movements.maxDropDown = 3
    movements.allow1by1towers = tower
    movements.scafoldingBlocks = tower
      ? ['dirt', 'cobblestone']
          .map((n) => this.bot.registry.itemsByName[n]?.id)
          .filter((id): id is number => id !== undefined)
      : []
    this.bot.pathfinder.setMovements(movements)
  }

  private names = (x: number, y: number, z: number) => this.bot.blockAt(new Vec3(x, y, z))?.name

  private inPlace(c: HandCell): boolean {
    const name = this.names(c.x, c.y, c.z)
    if (!name) return false
    // A door's item and block are named alike (wooden_door); a torch on a wall is a wall torch.
    if (c.block === 'torch') return /torch$/.test(name)
    if (c.block === 'bed') return /bed$/.test(name)
    return itemsFor(c.block).test(name)
  }

  /** How many items of a group or block the builder carries. */
  carried(block: string): number {
    const items = itemsFor(block)
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  /** What the job still needs, by group or block, beyond what the builder carries. */
  private needs(job: HandJob): Map<string, number> {
    const want = new Map<string, number>()
    for (const c of job.cells) if (!this.inPlace(c)) want.set(c.block, (want.get(c.block) ?? 0) + 1)
    for (const [block, n] of want) want.set(block, Math.max(0, n - this.carried(block)))
    // A door is made of six planks at a crafting table, itself four planks; a chest of eight.
    const doors = want.get('wooden_door') ?? 0
    if (doors > 0) want.set('planks', (want.get('planks') ?? 0) + 6 * doors + 4)
    const chests = want.get('chest') ?? 0
    if (chests > 0) want.set('planks', (want.get('planks') ?? 0) + 8 * chests + 4)
    // A furnace is eight cobblestone, at a crafting table.
    const furnaces = want.get('furnace') ?? 0
    if (furnaces > 0) {
      want.set('cobblestone', (want.get('cobblestone') ?? 0) + 8 * furnaces)
      want.set('planks', (want.get('planks') ?? 0) + 4)
    }
    // A few blocks to tower up on, in case a spot is out of reach.
    want.set('dirt', Math.max(0, (want.get('dirt') ?? 0) + 6 - this.carried('dirt')))
    return want
  }

  /** From the storehouse first; planks made from logs; wood and dirt dug by hand when short. */
  private async getMaterials(
    job: HandJob,
    storehouse?: { x: number; y: number; z: number }
  ): Promise<void> {
    let needs = this.needs(job)
    if (storehouse && [...needs.values()].some((n) => n > 0)) {
      await this.gatherer.withChest(storehouse, async (chest) => {
        for (const [block, n] of needs) {
          const left = await this.withdraw(chest, itemsFor(block), n)
          // Planks can be made from logs: four from each.
          if (block === 'planks' && left > 0)
            await this.withdraw(chest, /_log$/, Math.ceil(left / 4))
          // Torches are made from coal and sticks, four at a time; sticks from a log's planks.
          if (block === 'torch' && left > 0) {
            await this.withdraw(chest, /^(coal|charcoal)$/, Math.ceil(left / 4))
            if (this.carried('planks') < 2) await this.withdraw(chest, /_log$/, 1)
          }
        }
        return 0
      })
    }
    needs = this.needs(job)
    const planks = needs.get('planks') ?? 0
    if (planks > 0) await this.makePlanks(planks)
    needs = this.needs(job)
    const stillPlanks = needs.get('planks') ?? 0
    if (stillPlanks > 0 && !this.cancelled) {
      this.log.info(`${job.title}: chopping ${Math.ceil(stillPlanks / 4)} logs for planks`)
      await this.gatherer.collect('wood', Math.ceil(stillPlanks / 4))
      await this.makePlanks(stillPlanks)
    }
    const filler = this.needs(job).get('filler') ?? 0
    if (filler > 0) await this.makePlanks(filler)
    const stillFiller = this.needs(job).get('filler') ?? 0
    const dirt = (this.needs(job).get('dirt') ?? 0) + stillFiller
    if (dirt > 0 && !this.cancelled) await this.gatherer.collect('dirt', dirt)
    if ((this.needs(job).get('torch') ?? 0) > 0)
      await this.makeTorches(this.needs(job).get('torch') ?? 0)
    const doors = this.needs(job).get('wooden_door') ?? 0
    for (let i = 0; i < doors && !this.cancelled; i++) await this.makeDoor()
    const chests = this.needs(job).get('chest') ?? 0
    if (chests > 0 && !this.cancelled) await craft(this.bot, this.log, 'chest', chests)
    const tables = this.needs(job).get('crafting_table') ?? 0
    if (tables > 0 && !this.cancelled) await craft(this.bot, this.log, 'crafting_table', tables)
    const furnaces = this.needs(job).get('furnace') ?? 0
    if (furnaces > 0 && this.carried('cobblestone') >= 8 && !this.cancelled)
      await craft(this.bot, this.log, 'furnace', furnaces)
  }

  /** Take up to `count` matching items out of the chest; returns how many it could not find. */
  private async withdraw(chest: Chest, items: RegExp, count: number): Promise<number> {
    let left = count
    for (const item of chest.containerItems().filter((i) => items.test(i.name))) {
      if (left <= 0) break
      const n = Math.min(left, item.count)
      await withTimeout(chest.withdraw(item.type, item.metadata, n), 5_000)
      left -= n
    }
    return left
  }

  /** Planks from the logs carried, four from each (the small crafting grid will do). */
  private async makePlanks(want: number): Promise<void> {
    for (const log of this.bot.inventory.items().filter((i) => /_log$/.test(i.name))) {
      if (want <= 0) return
      const plank = this.bot.registry.itemsByName[log.name.replace(/_log$/, '_planks')]
      const recipe = plank && this.bot.recipesFor(plank.id, null, 1, null)[0]
      if (!recipe) {
        this.log.info(`no recipe for planks from ${log.name}`)
        continue
      }
      const times = Math.min(log.count, Math.ceil(want / 4))
      try {
        await withTimeout(this.bot.craft(recipe, times, undefined), 15_000)
        want -= times * 4
      } catch (err) {
        this.log.info(`could not make planks from ${log.name}: ${errMsg(err)}`)
      }
    }
  }

  /** What is left of the materials goes back into the storehouse (a little dirt is kept). */
  private async putBack(storehouse: { x: number; y: number; z: number }): Promise<void> {
    const leftovers = /(_planks|_log)$|^(coal|charcoal|stick|torch|crafting_table|wooden_door)$/
    if (!this.bot.inventory.items().some((i) => leftovers.test(i.name))) return
    await this.gatherer.withChest(storehouse, async (chest) => {
      for (const item of this.bot.inventory.items().filter((i) => leftovers.test(i.name)))
        await withTimeout(chest.deposit(item.type, item.metadata, item.count), 5_000)
      return 0
    })
  }

  /** Torches from coal (or charcoal) and sticks; sticks from planks. */
  private async makeTorches(want: number): Promise<void> {
    const coal = this.carriedAny(/^(coal|charcoal)$/)
    if (coal === 0) return void this.log.info('no coal for torches')
    const batches = Math.min(coal, Math.ceil(want / 4))
    // Sticks take two planks.
    if (this.carried('planks') < 2 && this.carried('stick') < batches) await this.makePlanks(4)
    if (this.carried('stick') < batches)
      await this.craft('stick', Math.ceil((batches - this.carried('stick')) / 4))
    await this.craft('torch', batches)
  }

  /** A door needs the big crafting grid: make a table, put it down, craft, take it back up. */
  private async makeDoor(): Promise<void> {
    if (this.carried('crafting_table') === 0 && !(await this.craft('crafting_table', 1))) return
    const me = this.bot.entity.position.floored()
    const spot = DIRECTIONS.slice(1, 5)
      .map(([dx, , dz]) => new Vec3(me.x + dx * 2, me.y, me.z + dz * 2))
      .find(
        (p) =>
          ROOM.test(this.names(p.x, p.y, p.z) ?? '') &&
          this.reference({ x: p.x, y: p.y, z: p.z, block: 'crafting_table' })
      )
    const table = this.bot.inventory.items().find((i) => i.name === 'crafting_table')
    if (!spot || !table) return void this.log.info('no room to put a crafting table down')
    const ref = this.reference({ x: spot.x, y: spot.y, z: spot.z, block: 'crafting_table' })!
    try {
      await this.bot.equip(table, 'hand')
      await withTimeout(this.bot.placeBlock(ref.block, ref.face), 5_000)
    } catch (err) {
      return void this.log.info(`could not put the crafting table down: ${errMsg(err)}`)
    }
    const placed = this.bot.blockAt(spot)
    if (placed?.name === 'crafting_table') {
      await this.craft('wooden_door', 1, placed)
      await withTimeout(this.bot.dig(placed, true), 10_000).catch((err) =>
        this.log.info(`could not take the crafting table back up: ${errMsg(err)}`)
      )
      await sleep(600)
    }
  }

  private carriedAny(items: RegExp): number {
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  private async craft(name: string, times: number, table?: Block): Promise<boolean> {
    const item = this.bot.registry.itemsByName[name]
    const recipe = item && this.bot.recipesFor(item.id, null, 1, table ?? null)[0]
    if (!recipe) {
      this.log.info(`no recipe for ${name} with what I carry`)
      return false
    }
    try {
      await withTimeout(this.bot.craft(recipe, times, table), 15_000)
      return true
    } catch (err) {
      this.log.info(`could not craft ${name}: ${errMsg(err)}`)
      return false
    }
  }

  /** Every cell, bottom layer first, nearest first; a cell waits until it has a neighbour to go on. */
  private async placeAll(job: HandJob, result: HandResult): Promise<void> {
    const todo = job.cells.filter((c) => !this.inPlace(c))
    while (todo.length && !this.cancelled) {
      const me = this.bot.entity.position
      todo.sort((a, b) => a.y - b.y || me.distanceTo(vec(a)) - me.distanceTo(vec(b)))
      const layer = todo[0].y
      const index = todo.findIndex((c) => c.y === layer && (c.replace || this.reference(c)))
      if (index === -1) {
        const stuck = todo.filter((c) => c.y === layer)
        this.log.info(
          `${job.title}: ${stuck.length} blocks on layer ${layer} have nothing to go on yet`
        )
        for (const c of stuck) todo.splice(todo.indexOf(c), 1)
        continue
      }
      const [cell] = todo.splice(index, 1)
      if (this.inPlace(cell)) continue
      if (await this.placeOne(cell)) result.placed++
    }
  }

  /** A solid neighbour to place against, and the face pointing from it to the cell. */
  private reference(c: HandCell): { block: Block; face: Vec3 } | null {
    for (const [dx, dy, dz] of c.against ? [c.against] : DIRECTIONS) {
      const block = this.bot.blockAt(new Vec3(c.x + dx, c.y + dy, c.z + dz))
      if (block && block.boundingBox === 'block' && !LIQUID.test(block.name))
        return { block, face: new Vec3(-dx, -dy, -dz) }
    }
    return null
  }

  private async placeOne(c: HandCell): Promise<boolean> {
    if (this.carried(c.block) === 0) return false
    if (c.head) return this.placeBed(c)
    for (let attempt = 0; attempt < 3 && !this.cancelled; attempt++) {
      if (!(await this.reach(c, attempt))) continue
      if (c.replace) {
        const there = this.bot.blockAt(vec(c))
        if (there && !ROOM.test(there.name) && !itemsFor(c.block).test(there.name)) {
          try {
            await withTimeout(this.bot.dig(there, true), 10_000)
          } catch (err) {
            this.log.info(`could not take up ${there.name} at ${key(c)}: ${errMsg(err)}`)
            continue
          }
        }
      }
      const ref = this.reference(c)
      if (!ref) return false
      const item =
        c.block === 'filler'
          ? FILLER_ORDER.map((kind) =>
              this.bot.inventory.items().find((i) => kind.test(i.name))
            ).find(Boolean)
          : this.bot.inventory.items().find((i) => itemsFor(c.block).test(i.name))
      if (!item) return false
      try {
        await this.bot.equip(item, 'hand')
        await withTimeout(this.bot.placeBlock(ref.block, ref.face), 5_000)
      } catch (err) {
        this.log.debug(`place ${item.name} at ${key(c)} (try ${attempt + 1}): ${errMsg(err)}`)
      }
      for (let i = 0; i < 5; i++) {
        if (this.inPlace(c)) return true
        await sleep(120)
      }
    }
    return false
  }

  /**
   * A bed lies the way its placer looks: stand behind the foot, look towards the head, and put
   * it on the floor.
   */
  private async placeBed(c: HandCell): Promise<boolean> {
    const [dx, dz] = c.head!
    const stand = new Vec3(c.x - dx, c.y, c.z - dz)
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z)),
        20_000
      )
    } catch (err) {
      this.log.info(`could not stand behind the bed at ${key(c)}: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
      return false
    }
    const floor = this.bot.blockAt(new Vec3(c.x, c.y - 1, c.z))
    const bed = this.bot.inventory.items().find((i) => i.name === 'bed')
    if (!floor || !bed) return false
    try {
      // Yaw: 0 looks south (+z), pi/2 west (-x), pi north (-z), -pi/2 east (+x).
      await this.bot.look(Math.atan2(-dx, dz), 0.6, true)
      await this.bot.equip(bed, 'hand')
      await withTimeout(this.bot.placeBlock(floor, new Vec3(0, 1, 0)), 5_000)
    } catch (err) {
      this.log.debug(`place bed at ${key(c)}: ${errMsg(err)}`)
    }
    await sleep(300)
    const head = this.names(c.x + dx, c.y, c.z + dz)
    return this.inPlace(c) && /bed$/.test(head ?? '')
  }

  /** Get within reach of a cell: walk to a spot to stand on, or failing that tower up near it. */
  private async reach(c: HandCell, attempt: number): Promise<boolean> {
    if (this.inReach(c)) return true
    const spots = this.standSpots(c).slice(attempt * 2, attempt * 2 + 2)
    for (const s of spots) {
      try {
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalBlock(s.x, s.y, s.z)), 20_000)
      } catch {
        this.bot.pathfinder.setGoal(null)
      }
      if (this.inReach(c)) return true
    }
    // Nowhere to stand: let the pathfinder tower up close to it.
    try {
      await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 3)), 30_000)
    } catch (err) {
      this.log.debug(`could not get near ${key(c)}: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
    }
    return this.inReach(c)
  }

  private inReach(c: HandCell): boolean {
    const p = this.bot.entity.position
    const eyes = p.offset(0, 1.62, 0)
    if (eyes.distanceTo(vec(c).offset(0.5, 0.5, 0.5)) > REACH) return false
    // Not standing in the cell itself.
    const feet = p.floored()
    return !(feet.x === c.x && feet.z === c.z && (c.y === feet.y || c.y === feet.y + 1))
  }

  /** Places to stand from which the cell is within reach, nearest to the builder first. */
  private standSpots(c: HandCell): Vec3[] {
    const spots: Vec3[] = []
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++)
        for (let y = c.y + 1; y >= c.y - 5; y--) {
          const x = c.x + dx
          const z = c.z + dz
          if (x === c.x && z === c.z && (y === c.y || y + 1 === c.y)) continue
          const floor = this.bot.blockAt(new Vec3(x, y - 1, z))
          if (!floor || floor.boundingBox !== 'block' || LIQUID.test(floor.name)) continue
          if (!ROOM.test(this.names(x, y, z) ?? '') || !ROOM.test(this.names(x, y + 1, z) ?? ''))
            continue
          const eyes = new Vec3(x + 0.5, y + 1.62, z + 0.5)
          if (eyes.distanceTo(vec(c).offset(0.5, 0.5, 0.5)) <= REACH - 0.3)
            spots.push(new Vec3(x, y, z))
        }
    const me = this.bot.entity.position
    return spots.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  }

  /** Take the scaffolding away, top down (standing on a tower, dig the block underfoot). */
  private async clearScaffold(scaffold: Vec3[]): Promise<void> {
    if (!scaffold.length) return
    this.log.info(`taking away ${scaffold.length} scaffolding blocks`)
    for (const p of [...scaffold].sort((a, b) => b.y - a.y)) {
      const block = this.bot.blockAt(p)
      if (!block || !SCAFFOLD.test(block.name)) continue
      const eyes = this.bot.entity.position.offset(0, 1.62, 0)
      if (eyes.distanceTo(p.offset(0.5, 0.5, 0.5)) > REACH) {
        try {
          await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3)), 20_000)
        } catch {
          this.bot.pathfinder.setGoal(null)
        }
      }
      try {
        await withTimeout(this.bot.dig(block, true), 10_000)
      } catch (err) {
        this.log.info(`could not take away scaffolding at ${p}: ${errMsg(err)}`)
      }
    }
  }
}

function vec(c: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(c.x, c.y, c.z)
}
