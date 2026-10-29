import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'

/**
 * The only animals the court hunts (the King's rule: never a named or tame animal). Kinds that
 * can be tamed (horses, wolves, cats, parrots, llamas...) are never touched, tame or not.
 */
export const GAME = /^(cow|pig|sheep|chicken|rabbit)$/
/** What a hunt brings home: meat (raw), leather, wool, feathers. */
export const SPOILS =
  /^(beef|porkchop|mutton|chicken|rabbit|leather|rabbit_hide|rabbit_foot|feather|[a-z_]*wool)$/
/** Somebody's pen: fences or walls close by. */
const PEN = /(fence|fence_gate|_wall)$/

/** Keep this far from every player (no hunting under the Princess's nose). */
export const HUNT_KEEP_AWAY = 16
/** Always leave at least this many of a kind alive nearby, to breed. */
const LEAVE = 2
const KIN_RANGE = 24
const SEARCH = 48
const STRIKE = 3
const CHASE_MS = 20_000
const HUNT_MS = 4 * 60_000

/** What the hunt needs to know about an animal. */
export interface Animal {
  id: number
  name?: string
  position: Vec3
  metadata?: Record<string, unknown>
}

/** Never named, tame, owned, leashed or a baby. */
export function wild(animal: Animal): boolean {
  if (!animal.name || !GAME.test(animal.name)) return false
  const md = animal.metadata ?? {}
  const nametag = md.nametag
  if (typeof nametag === 'string' && nametag.trim() !== '') return false
  const flags = (md.flags ?? {}) as Record<string, unknown>
  if (flags.baby === true || flags.tamed === true || flags.leashed === true) return false
  const owner = md.owner_eid
  if (owner !== undefined && owner !== null && BigInt(owner as bigint | number) > 0n) return false
  return true
}

type HuntBot = MineflayerBot & { pathfinder: Pathfinder }

export interface HuntResult {
  killed: number
  /** Meat brought home (or carried, without a storehouse). */
  meat: number
  reason?: 'none_found' | 'cancelled' | 'too_long'
}

/**
 * Hunts for the court's food: the nearest wild cow, pig, sheep, chicken or rabbit that may be
 * taken, well away from players and pens, never the last two of a kind; picks up the drops.
 */
export class Hunter {
  private readonly bot: HuntBot
  private cancelled = false

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly isBot: (name: string) => boolean
  ) {
    this.bot = bot as HuntBot
  }

  cancel(): void {
    this.cancelled = true
    this.bot.pathfinder.setGoal(null)
  }

  meatCarried(): number {
    return this.bot.inventory
      .items()
      .filter((i) => /^(beef|porkchop|mutton|chicken|rabbit)$/.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }

  async hunt(animals: number): Promise<HuntResult> {
    this.cancelled = false
    const start = Date.now()
    const before = this.meatCarried()
    const passed = new Set<number>()
    let killed = 0
    let reason: HuntResult['reason']
    while (killed < animals) {
      if (this.cancelled) {
        reason = 'cancelled'
        break
      }
      if (Date.now() - start > HUNT_MS) {
        reason = 'too_long'
        break
      }
      const prey = this.prey(passed)
      if (!prey) {
        reason = 'none_found'
        break
      }
      passed.add(prey.id)
      if (await this.take(prey)) killed++
    }
    const meat = Math.max(0, this.meatCarried() - before)
    this.log.info(`hunted ${killed} animals, ${meat} meat${reason ? ` (${reason})` : ''}`)
    return { killed, meat, reason }
  }

  /** Where the real players are (not the court's bots). */
  private players(): Vec3[] {
    return Object.values(this.bot.players)
      .filter((p) => p.username !== this.bot.username && !this.isBot(p.username) && p.entity)
      .map((p) => p.entity.position)
  }

  /** The nearest animal that may be taken. */
  private prey(passed: Set<number>): Animal | undefined {
    const me = this.bot.entity.position
    const players = this.players()
    const animals = Object.values(this.bot.entities) as unknown as Animal[]
    return animals
      .filter((a) => !passed.has(a.id) && wild(a) && a.position.distanceTo(me) <= SEARCH)
      .filter((a) => players.every((p) => p.distanceTo(a.position) >= HUNT_KEEP_AWAY))
      .filter(
        (a) =>
          animals.filter(
            (k) => k.name === a.name && k.position.distanceTo(a.position) <= KIN_RANGE && wild(k)
          ).length > LEAVE
      )
      .filter((a) => !this.nearPen(a.position))
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  }

  private nearPen(p: Vec3): boolean {
    return (
      this.bot.findBlocks({
        matching: (b: { name: string }) => PEN.test(b.name),
        point: p,
        maxDistance: 4,
        count: 1,
      }).length > 0
    )
  }

  /** Chase and strike until it falls; then walk over the drops. */
  private async take(prey: Animal): Promise<boolean> {
    const weapon = this.bot.inventory.items().find((i) => /_(sword|axe)$/.test(i.name))
    if (weapon) await this.bot.equip(weapon, 'hand').catch(() => {})
    const start = Date.now()
    let last = prey.position.clone()
    try {
      while (Date.now() - start < CHASE_MS && !this.cancelled) {
        const live = this.bot.entities[prey.id] as unknown as Animal | undefined
        if (!live) {
          await this.pickUp(last)
          this.log.info(`took a ${prey.name}`)
          return true
        }
        last = live.position.clone()
        if (live.position.distanceTo(this.bot.entity.position) > STRIKE) {
          this.bot.pathfinder.setGoal(new goals.GoalFollow(live as never, 1.5), true)
          await sleep(300)
          continue
        }
        await this.bot.lookAt(live.position.offset(0, 0.5, 0)).catch(() => {})
        this.bot.attack(live as never)
        await sleep(650)
      }
    } catch (err) {
      this.log.info(`the hunt broke off: ${errMsg(err)}`)
    } finally {
      this.bot.pathfinder.setGoal(null)
    }
    return false
  }

  private async pickUp(near: Vec3): Promise<void> {
    await sleep(500)
    const drops = Object.values(this.bot.entities).filter(
      (e) => e.name === 'item' && e.position.distanceTo(near) < 6
    )
    for (const drop of drops) {
      const p = drop.position
      try {
        await withTimeout(this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)), 10_000)
      } catch {
        this.bot.pathfinder.setGoal(null)
      }
    }
  }
}
