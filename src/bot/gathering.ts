import type { Chest, Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'

/** What a royal can send a courtier to fetch in survival: everything a bare hand can dig. */
export const MATERIALS = ['dirt', 'wood', 'sand', 'gravel'] as const
export type Material = (typeof MATERIALS)[number]

interface MaterialInfo {
  /** Blocks it is dug from. */
  blocks: RegExp
  /** Items that drop (grass gives dirt, gravel now and then flint). */
  items: RegExp
  /** Tools that dig it faster, best first. */
  tools: RegExp
  /** Grows on trees rather than lying in the ground. */
  tree?: boolean
}

export const MATERIAL_INFO: Record<Material, MaterialInfo> = {
  dirt: { blocks: /^(grass_block|dirt)$/, items: /^dirt$/, tools: /_shovel$/ },
  wood: {
    blocks: /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/,
    items: /_log$/,
    tools: /_axe$/,
    tree: true,
  },
  sand: { blocks: /^(sand|red_sand)$/, items: /^(sand|red_sand)$/, tools: /_shovel$/ },
  gravel: { blocks: /^gravel$/, items: /^(gravel|flint)$/, tools: /_shovel$/ },
}

/** Ground a dug block may sit in: whatever the land itself is made of. */
const GROUND =
  /^(grass_block|dirt|coarse_dirt|podzol|mycelium|rooted_dirt|mud|clay|sand|red_sand|gravel|stone|andesite|diorite|granite|tuff|deepslate|sandstone|red_sandstone|moss_block|snow)$/
/** What may lie on top of a ground block that is dug: air, grass, flowers, snow. */
const COVER =
  /^(air|short_grass|tall_grass|fern|large_fern|snow_layer|leaf_litter|bush|wildflowers|short_dry_grass|tall_dry_grass|dead_bush|deadbush|poppy|dandelion|allium|cornflower|azure_bluet|oxeye_daisy|[a-z_]*_tulip|lily_of_the_valley|pink_petals)$/
const LEAVES = /_leaves$/

/** Block names by position; undefined where the world is not loaded. */
export type BlockNames = (x: number, y: number, z: number) => string | undefined

/** Keep at least this far (blocks) from every player: never dig near what someone is making. */
export const KEEP_AWAY = 16
/** How far from the bot it looks for something to dig, and how many places it notes at once. */
const SEARCH = 48
const CANDIDATES = 80
/** Close enough to toss things over. */
const TOSS_RANGE = 4
/** Reach for digging, from the eyes. */
const REACH = 4.5
/** The longest a whole errand may take. */
const ERRAND_MS = 4 * 60_000

/**
 * Untouched land only, never anything someone built: a ground block lies in the surface with
 * ground on all four sides and below and only grass, flowers or air above; a log belongs to a
 * tree, with leaves close by.
 */
export function untouched(
  material: Material,
  names: BlockNames,
  x: number,
  y: number,
  z: number
): boolean {
  const info = MATERIAL_INFO[material]
  const here = names(x, y, z)
  if (!here || !info.blocks.test(here)) return false
  if (info.tree) {
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -1; dy <= 4; dy++)
        for (let dz = -3; dz <= 3; dz++)
          if (LEAVES.test(names(x + dx, y + dy, z + dz) ?? '')) return true
    return false
  }
  const above = names(x, y + 1, z)
  if (!above || !COVER.test(above)) return false
  // Open sky all round: the floor of a hole (even the one the bot stands in) is not the surface,
  // or a bot would dig itself into a shaft it cannot climb out of.
  const open = [
    names(x + 1, y + 1, z),
    names(x - 1, y + 1, z),
    names(x, y + 1, z + 1),
    names(x, y + 1, z - 1),
  ]
  if (!open.every((n) => n !== undefined && COVER.test(n))) return false
  const sides = [names(x + 1, y, z), names(x - 1, y, z), names(x, y, z + 1), names(x, y, z - 1)]
  if (!sides.every((n) => n !== undefined && GROUND.test(n))) return false
  const below = names(x, y - 1, z)
  return below !== undefined && GROUND.test(below)
}

/** Where the fetched things go: to a player, or into the storehouse chest. */
export type Destination = { player: string } | { chest: { x: number; y: number; z: number } }

const CONTAINER = /^(chest|trapped_chest|barrel)$/

export interface GatherResult {
  /** How many it dug up and picked up. */
  gathered: number
  /** How many it handed over. */
  delivered: number
  /** Why it stopped short, if it did. */
  reason?: 'none_found' | 'cancelled' | 'too_long' | 'not_delivered'
}

type GatherBot = MineflayerBot & { pathfinder: Pathfinder }

/**
 * Fetches a material for a player by hand: walks to untouched land at least KEEP_AWAY from
 * everyone, digs, picks the drops up, and tosses them to the player.
 */
export class Gatherer {
  private readonly bot: GatherBot
  private cancelled = false

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    /** The court's own bots: they are not building anything, so they need no keeping away from. */
    private readonly isBot: (name: string) => boolean = () => false
  ) {
    this.bot = bot as GatherBot
  }

  cancel(): void {
    this.cancelled = true
    this.bot.pathfinder.setGoal(null)
  }

  /** How many of the material's items the bot carries. */
  carried(material: Material): number {
    const items = MATERIAL_INFO[material].items
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  /** What the storehouse held when this bot last opened it. */
  lastStock?: Record<string, number>

  async fetch(material: Material, want: number, to: Destination): Promise<GatherResult> {
    const { gathered, reason } = await this.collect(material, want)
    if (gathered === 0 || this.cancelled) return { gathered, delivered: 0, reason }
    const delivered =
      'player' in to
        ? await this.deliver(material, gathered, to.player)
        : await this.store(material, gathered, to.chest)
    return { gathered, delivered, reason: delivered < gathered ? 'not_delivered' : reason }
  }

  /** Dig the material up and keep it (a builder chopping wood for his planks). */
  async collect(
    material: Material,
    want: number
  ): Promise<{ gathered: number; reason?: GatherResult['reason'] }> {
    this.cancelled = false
    const start = Date.now()
    const before = this.carried(material)
    const tried = new Set<string>()
    let reason: GatherResult['reason']
    let candidates = this.search(material)
    let searched = Date.now()
    while (this.carried(material) - before < want) {
      if (this.cancelled) {
        reason = 'cancelled'
        break
      }
      if (Date.now() - start > ERRAND_MS) {
        reason = 'too_long'
        break
      }
      let target = this.nearest(material, candidates, tried)
      // The land near the start is used up: look again from here, once in a while.
      if (!target && Date.now() - searched > 5_000) {
        candidates = this.search(material)
        searched = Date.now()
        target = this.nearest(material, candidates, tried)
      }
      if (!target) {
        reason = 'none_found'
        break
      }
      tried.add(target.toString())
      await this.digOne(material, target)
    }
    const gathered = Math.max(0, this.carried(material) - before)
    this.log.info(`gathered ${gathered} of ${want} ${material}${reason ? ` (${reason})` : ''}`)
    return { gathered, reason }
  }

  private names: BlockNames = (x, y, z) => this.bot.blockAt(new Vec3(x, y, z))?.name

  /** Where the real players are (not the court's bots). */
  private players(): Vec3[] {
    return Object.values(this.bot.players)
      .filter((p) => p.username !== this.bot.username && !this.isBot(p.username) && p.entity)
      .map((p) => p.entity.position)
  }

  /** May this block be dug: untouched land, far enough from every player, not underfoot. */
  private allowed(material: Material, p: Vec3, players: Vec3[]): boolean {
    const me = this.bot.entity?.position.floored()
    if (me && Math.abs(me.x - p.x) <= 1 && Math.abs(me.z - p.z) <= 1 && p.y < me.y) return false
    return (
      players.every((q) => q.distanceTo(p) >= KEEP_AWAY) &&
      untouched(material, this.names, p.x, p.y, p.z)
    )
  }

  /** Untouched blocks of the material around the bot, nearest first. */
  private search(material: Material): Vec3[] {
    const info = MATERIAL_INFO[material]
    const players = this.players()
    const found = this.bot.findBlocks({
      matching: (block: { name: string }) => info.blocks.test(block.name),
      useExtraInfo: (block: { position: Vec3 }) => this.allowed(material, block.position, players),
      maxDistance: SEARCH,
      count: CANDIDATES,
    } as never)
    this.log.info(`found ${found.length} places with untouched ${material} nearby`)
    return found
  }

  /** The nearest place not tried yet that may still be dug (players move, holes appear). */
  private nearest(material: Material, places: Vec3[], tried: Set<string>): Vec3 | undefined {
    const me = this.bot.entity?.position
    if (!me) return undefined
    const players = this.players()
    return places
      .filter((p) => !tried.has(p.toString()))
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
      .find((p) => this.allowed(material, p, players))
  }

  /** Walk over, dig it, and pick up what drops. */
  private async digOne(material: Material, target: Vec3): Promise<void> {
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNearXZ(target.x, target.z, 2)),
        30_000
      )
    } catch (err) {
      this.log.info(`could not get to ${target}: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
      return
    }
    const eyes = this.bot.entity.position.offset(0, 1.62, 0)
    if (eyes.distanceTo(target.offset(0.5, 0.5, 0.5)) > REACH) return
    const block = this.bot.blockAt(target)
    if (!block || !MATERIAL_INFO[material].blocks.test(block.name)) return
    await this.equipTool(material)
    try {
      await withTimeout(this.bot.dig(block, true), 15_000)
    } catch (err) {
      this.log.info(`could not dig ${block.name} at ${target}: ${errMsg(err)}`)
      return
    }
    await this.pickUp(target)
  }

  private async equipTool(material: Material): Promise<void> {
    const tool = this.bot.inventory.items().find((i) => MATERIAL_INFO[material].tools.test(i.name))
    if (!tool) return
    await this.bot
      .equip(tool, 'hand')
      .catch((err) => this.log.debug(`could not take up ${tool.name}: ${errMsg(err)}`))
  }

  /** Walk onto the dropped items (a log's fall to the foot of the tree). */
  private async pickUp(near: Vec3): Promise<void> {
    await sleep(500)
    const drops = Object.values(this.bot.entities).filter(
      (e) => e.name === 'item' && e.position.distanceTo(near) < 8
    )
    for (const drop of drops) {
      const p = drop.position
      try {
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)), 10_000)
      } catch {
        this.bot.pathfinder.setGoal(null)
      }
    }
    await sleep(400)
  }

  /** Put the things in the storehouse chest. Returns how many went in; notes what it holds. */
  async store(
    material: Material,
    count: number,
    chest: { x: number; y: number; z: number }
  ): Promise<number> {
    const items = MATERIAL_INFO[material].items
    return this.withChest(chest, async (window) => {
      let left = count
      for (const item of this.bot.inventory.items().filter((i) => items.test(i.name))) {
        if (left <= 0) break
        const n = Math.min(left, item.count)
        await withTimeout(window.deposit(item.type, item.metadata, n), 5_000)
        left -= n
      }
      return count - left
    })
  }

  /**
   * Walk to the storehouse chest, open it, do the work, note what it holds and close it. Returns
   * the work's answer, or 0 when the chest could not be reached or opened.
   */
  async withChest(
    chest: { x: number; y: number; z: number },
    work: (window: Chest) => Promise<number>
  ): Promise<number> {
    const pos = new Vec3(chest.x, chest.y, chest.z)
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
        60_000
      )
    } catch (err) {
      this.log.info(`could not walk to the storehouse: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
    }
    const block = this.bot.blockAt(pos)
    if (!block || !CONTAINER.test(block.name)) {
      this.log.info(`the storehouse at ${pos} is ${block?.name ?? 'out of sight'}, not a chest`)
      return 0
    }
    let window: Chest
    try {
      window = (await withTimeout(this.bot.openContainer(block), 8_000)) as Chest
    } catch (err) {
      this.log.info(`could not open the storehouse: ${errMsg(err)}`)
      return 0
    }
    try {
      return await work(window)
    } catch (err) {
      this.log.info(`storehouse work failed: ${errMsg(err)}`)
      return 0
    } finally {
      const stock: Record<string, number> = {}
      for (const item of window.containerItems())
        stock[item.name] = (stock[item.name] ?? 0) + item.count
      this.lastStock = stock
      await Promise.resolve(window.close()).catch(() => {})
    }
  }

  /** Bring the things to the player and toss them over. Returns how many were handed over. */
  private async deliver(material: Material, count: number, player: string): Promise<number> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const target = this.bot.players[player]?.entity
      if (!target) {
        this.log.info(`${player} is out of sight: keeping the ${material}`)
        return 0
      }
      if (target.position.distanceTo(this.bot.entity.position) <= TOSS_RANGE) break
      const p = target.position
      try {
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), 60_000)
      } catch (err) {
        this.log.info(`could not walk over to ${player} (try ${attempt}): ${errMsg(err)}`)
        this.bot.pathfinder.setGoal(null)
        await sleep(1_000)
      }
    }
    const near = this.bot.players[player]?.entity
    const gap = near?.position.distanceTo(this.bot.entity.position)
    if (!near || gap === undefined || gap > TOSS_RANGE + 2) {
      this.log.info(
        `${player} is ${gap?.toFixed(1) ?? 'nowhere'} blocks away: keeping the ${material}`
      )
      return 0
    }
    await this.bot.lookAt(near.position.offset(0, 1.6, 0)).catch(() => {})
    const items = MATERIAL_INFO[material].items
    let left = count
    for (const item of this.bot.inventory.items().filter((i) => items.test(i.name))) {
      if (left <= 0) break
      const n = Math.min(left, item.count)
      try {
        await withTimeout(this.bot.toss(item.type, item.metadata, n), 5_000)
        left -= n
      } catch (err) {
        this.log.info(`could not toss ${item.name}: ${errMsg(err)}`)
      }
    }
    return count - left
  }
}
