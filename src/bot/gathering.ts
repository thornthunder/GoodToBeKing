import type { Chest, Bot as MineflayerBot } from 'mineflayer-bedrock'
import { Movements, goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { foundAt, scout, SCOUT_LEGS } from './scouting'

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
const SAPLING = /_sapling$/
/** What a tree gives besides its logs, kept in the storehouse. */
const TREE_GIFTS = /_sapling$|^(stick|apple)$/
/** Saplings a gatherer breaks leaves for, for the grove. */
const SAPLINGS_WANTED = 6
const LOG = /_log$/
/** Whatever the land is made of, or grows or flows on it: anything else, someone made. */
const WILD =
  /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava|seagrass|tall_seagrass|kelp|kelp_plant|lily_pad|vine|glow_lichen|sugar_cane|cactus|brown_mushroom|red_mushroom|pumpkin|melon_block|sweet_berry_bush|peony|rose_bush|lilac|sunflower|moss_carpet|ice|snow|calcite|dripstone_block|pointed_dripstone|bedrock|obsidian|[a-z_]*_ore)$/

/** The sky must be open this far above a dug block: a hall's floor or a cave is not the surface. */
const SKY = 24
/** Nothing anyone made (planks, torches, a door, a field) this close to land that is dug. */
const MADE_NEAR = 3

/** Block names by position; undefined where the world is not loaded. */
export type BlockNames = (x: number, y: number, z: number) => string | undefined

/** Keep at least this far (blocks) from every player: never dig near what someone is making. */
export const KEEP_AWAY = 16
/** How far from the bot it looks for something to dig, and how many places it notes at once. */
const SEARCH = 48
/** Trees are fewer: look further for them. */
const SEARCH_WOOD = 160
const CANDIDATES = 80
/** Close enough to toss things over. */
const TOSS_RANGE = 4
/** Reach for digging, from the eyes. */
const REACH = 4.5
/** The longest a whole errand may take. */
const ERRAND_MS = 4 * 60_000

/**
 * Untouched land only, never anything someone built: a ground block lies in the surface, under
 * open sky, with ground on all four sides and below and only grass, flowers or air above, and
 * not at the bottom of a pit; a log belongs to a tree, with leaves close by. Neither has
 * anything made by anyone close by (the court's own mended dirt sits among planks and torches).
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
  if (info.tree) return nearLeaves(names, x, y, z) && nothingMade(names, x, y, z)
  const above = names(x, y + 1, z)
  if (!above || !COVER.test(above)) return false
  const sides = [names(x + 1, y, z), names(x - 1, y, z), names(x, y, z + 1), names(x, y, z - 1)]
  if (!sides.every((n) => n !== undefined && GROUND.test(n))) return false
  const below = names(x, y - 1, z)
  if (below === undefined || !GROUND.test(below)) return false
  // Open all round, two blocks out: the floor of a hole or a pit (even the one the bot stands
  // in) is not the surface, or the court digs the land down into a quarry it cannot climb out of.
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++) {
      const n = names(x + dx, y + 1, z + dz)
      if (n === undefined || !(COVER.test(n) || LEAVES.test(n) || LOG.test(n))) return false
    }
  // Open sky: under a roof (the hall's floor), an overhang or in a cave it is not the surface.
  for (let dy = 2; dy <= SKY; dy++) {
    const n = names(x, y + dy, z)
    if (n !== undefined && !COVER.test(n) && !LEAVES.test(n) && !LOG.test(n)) return false
  }
  return nothingMade(names, x, y, z)
}

function nearLeaves(names: BlockNames, x: number, y: number, z: number): boolean {
  for (let dx = -3; dx <= 3; dx++)
    for (let dy = -1; dy <= 4; dy++)
      for (let dz = -3; dz <= 3; dz++)
        if (LEAVES.test(names(x + dx, y + dy, z + dz) ?? '')) return true
  return false
}

/** Nothing but the land itself, and what grows on it, within MADE_NEAR blocks. */
function nothingMade(names: BlockNames, x: number, y: number, z: number): boolean {
  for (let dx = -MADE_NEAR; dx <= MADE_NEAR; dx++)
    for (let dy = -2; dy <= 3; dy++)
      for (let dz = -MADE_NEAR; dz <= MADE_NEAR; dz++) {
        const n = names(x + dx, y + dy, z + dz)
        if (n === undefined) continue
        if (!GROUND.test(n) && !COVER.test(n) && !LEAVES.test(n) && !LOG.test(n) && !WILD.test(n))
          return false
      }
  return true
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
    private readonly isBot: (name: string) => boolean = () => false,
    /** The court's own grounds (home, storehouse, field, mine): kept clear like a player. */
    private readonly grounds: () => Array<{ x: number; y: number; z: number }> = () => []
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
    // Logs high up need a pillar to climb: some dirt first.
    if (material === 'wood' && this.carried('dirt') < 12)
      await this.collect('dirt', 16 - this.carried('dirt'))
    const start = Date.now()
    const before = this.carried(material)
    const tried = new Set<string>()
    let reason: GatherResult['reason']
    let candidates = this.search(material)
    let searched = Date.now()
    let legs = 0
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
      // No trees in sight: walk out to look further (where some were found last, else round about).
      while (!target && material === 'wood' && legs < SCOUT_LEGS && !this.cancelled) {
        await scout(this.bot, this.log, 'trees', legs++)
        candidates = this.search(material)
        searched = Date.now()
        target = this.nearest(material, candidates, tried)
      }
      if (!target) {
        reason = 'none_found'
        break
      }
      if (material === 'wood') foundAt('trees', target)
      tried.add(target.toString())
      await this.digOne(material, target)
    }
    const gathered = Math.max(0, this.carried(material) - before)
    this.log.info(`gathered ${gathered} of ${want} ${material}${reason ? ` (${reason})` : ''}`)
    return { gathered, reason }
  }

  private names: BlockNames = (x, y, z) => this.bot.blockAt(new Vec3(x, y, z))?.name

  /** Where the real players are (not the court's bots), and the court's own grounds. */
  private players(): Vec3[] {
    return Object.values(this.bot.players)
      .filter((p) => p.username !== this.bot.username && !this.isBot(p.username) && p.entity)
      .map((p) => p.entity.position)
      .concat(this.grounds().map((g) => new Vec3(g.x, g.y, g.z)))
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
      maxDistance: material === 'wood' ? SEARCH_WOOD : SEARCH,
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

  /** Walk over, dig it (climbing to a log high up), and pick up what drops. */
  async digOne(material: Material, target: Vec3): Promise<void> {
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
    if (eyes.distanceTo(target.offset(0.5, 0.5, 0.5)) > REACH) {
      // A log high up (the trunk below already chopped): climb a pillar of dirt to it.
      if (MATERIAL_INFO[material].tree && (await this.climbAndDig(material, target)))
        await this.pickUp(target)
      return
    }
    const block = this.bot.blockAt(target)
    if (!block || !MATERIAL_INFO[material].blocks.test(block.name)) return
    await this.equipTool(material)
    try {
      await withTimeout(this.bot.dig(block, true), 15_000)
    } catch (err) {
      this.log.info(`could not dig ${block.name} at ${target}: ${errMsg(err)}`)
      return
    }
    if (MATERIAL_INFO[material].tree) await this.leavesForSaplings(target)
    await this.pickUp(target)
  }

  /**
   * Break the leaves within reach of a felled log while the court is short of saplings: one in
   * twenty drops one, for the grove at home (a few seconds' work by hand).
   */
  async leavesForSaplings(near: Vec3, want = SAPLINGS_WANTED): Promise<void> {
    if (this.carriedItems(SAPLING) >= want) return
    const eyes = () => this.bot.entity.position.offset(0, 1.62, 0)
    const leaves = this.bot.findBlocks({
      matching: (b: { name: string }) => LEAVES.test(b.name),
      point: near,
      maxDistance: 5,
      count: 24,
    })
    for (const p of leaves) {
      if (this.cancelled || this.carriedItems(SAPLING) >= want) break
      if (eyes().distanceTo(p.offset(0.5, 0.5, 0.5)) > REACH) continue
      const block = this.bot.blockAt(p)
      if (!block || !LEAVES.test(block.name)) continue
      await withTimeout(this.bot.dig(block, true), 3_000).catch(() => {})
    }
  }

  private carriedItems(items: RegExp): number {
    return this.bot.inventory
      .items()
      .filter((i) => items.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  /**
   * Tower up on dirt to a block out of reach, dig it, and come back down taking the pillar
   * away (standing on it, the block underfoot first), as a player would.
   */
  private async climbAndDig(material: Material, target: Vec3): Promise<boolean> {
    const dirtId = this.bot.registry.itemsByName.dirt?.id
    const dirt = this.bot.inventory.items().find((i) => i.name === 'dirt')
    // Whatever dirt there is: the pathfinder knows how far it will go.
    if (!dirtId || !dirt) {
      this.log.info(`no dirt to climb to the log at ${target}`)
      return false
    }
    const pillar: Vec3[] = []
    const onPlaced = (_old: unknown, block: { name?: string; position?: Vec3 } | null) => {
      if (block?.position && block.name === 'dirt') pillar.push(block.position.clone())
    }
    const events = this.bot as unknown as NodeJS.EventEmitter
    events.on('blockPlaced', onPlaced)
    const everyday = this.bot.pathfinder.movements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const climbing = new Movements(this.bot as any)
    climbing.canDig = false
    climbing.allowParkour = false
    climbing.allow1by1towers = true
    climbing.scafoldingBlocks = [dirtId]
    climbing.maxDropDown = 3
    climbing.canOpenDoors = everyday.canOpenDoors
    this.bot.pathfinder.setMovements(climbing)
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3)),
        30_000
      )
      const eyes = this.bot.entity.position.offset(0, 1.62, 0)
      const block = this.bot.blockAt(target)
      if (eyes.distanceTo(target.offset(0.5, 0.5, 0.5)) > REACH || !block) return false
      if (!MATERIAL_INFO[material].blocks.test(block.name)) return false
      await this.equipTool(material)
      await withTimeout(this.bot.dig(block, true), 15_000)
      this.log.info(`climbed ${pillar.length} blocks to the log at ${target}`)
      return true
    } catch (err) {
      this.log.info(`could not climb to ${target}: ${errMsg(err)}`)
      this.bot.pathfinder.setGoal(null)
      return false
    } finally {
      events.removeListener('blockPlaced', onPlaced)
      this.bot.pathfinder.setMovements(everyday)
      for (const p of pillar.sort((a, b) => b.y - a.y)) {
        const block = this.bot.blockAt(p)
        if (block?.name === 'dirt')
          await withTimeout(this.bot.dig(block, true), 8_000).catch(() => {})
      }
    }
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
      // What a tree gives besides its logs: saplings for the grove, sticks, apples.
      if (MATERIAL_INFO[material].tree)
        for (const item of this.bot.inventory.items().filter((i) => TREE_GIFTS.test(i.name)))
          await withTimeout(window.deposit(item.type, item.metadata, item.count), 5_000)
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
    // A chest opens from four blocks: the hall is crowded (beds, bots), so do not insist on two.
    for (const range of [3, 4]) {
      const eyes = this.bot.entity.position.offset(0, 1.62, 0)
      if (eyes.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.5) break
      try {
        await withTimeout(
          this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)),
          60_000
        )
        break
      } catch (err) {
        this.log.info(`could not walk to the storehouse (within ${range}): ${errMsg(err)}`)
        this.bot.pathfinder.setGoal(null)
      }
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
