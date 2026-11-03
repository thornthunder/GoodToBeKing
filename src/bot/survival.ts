import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { CREEPER_WATCH, leadPoint } from './creepers'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'

/** What a courtier eats, best first. */

/** When someone of the court (this mind) last said they were hungry with nothing to eat. */
let hungerSaid = 0
const HUNGER_WORDS_MS = 30 * 60_000

export const FOODS = [
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_salmon',
  'cooked_cod',
  'cooked_rabbit',
  'baked_potato',
  'bread',
  'pumpkin_pie',
  'golden_carrot',
  'carrot',
  'apple',
  'beetroot',
  'melon_slice',
  'sweet_berries',
  'cookie',
  // Raw meat only when nothing else is left (never raw chicken: it makes one ill).
  'beef',
  'porkchop',
  'mutton',
  'rabbit',
]
const FOOD = new RegExp(`^(${FOODS.join('|')})$`)

/** Monsters the guards fight. Creepers and endermen are left alone: fighting them goes badly. */
export const HOSTILE =
  /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|spider|cave_spider|witch|pillager|vindicator|slime|silverfish|zoglin|hoglin|piglin_brute)$/
const WEAPONS = [/_sword$/, /_axe$/]

/** Eat below this much food (of 20): low enough not to nibble all day. */
export const HUNGRY = 14
/** Hurt, eat up to this: health only comes back above it. */
export const HEAL = 18
/** Guards look this far around a royal (or themselves) for monsters. */
const GUARD_RANGE = 12
const SELF_RANGE = 6
/** Melee reach. */
const STRIKE = 3
/** The longest one fight may last. */
const FIGHT_MS = 30_000
/** A creeper this close is walked away from, till it is this far. */
const CREEPER_NEAR = 9
const CREEPER_SAFE = 12
/** The first thing on sight of one at arm's length: a dash straight away from it, before any path is thought out. */
const DASH_WITHIN = 5
const DASH_MS = 700
/** A monster it has not got any closer to for this long is out of reach (in a pit, behind a wall). */
const OUT_OF_REACH_MS = 6_000
/** Enemies this close to the spot a defender holds are fought (the war game). */
const DEFEND_RANGE = 12

type SurvivalBot = MineflayerBot & { pathfinder: Pathfinder }

/** How a courtier fights players of the other side in the war game (src/war). */
export type Aggression = 'none' | 'near' | 'range'

export interface SurvivalOptions {
  /** A guard defends the royal family (duty: escort). */
  guard: boolean
  /** Where royals stand right now (the ones in sight). */
  royals: () => Vec3[]
  /** Is this spot inside the court's hall? */
  inside?: (p: Vec3) => boolean
  /** Players of the other side in the war game (lower-cased names): foes, as `aggression` allows. */
  enemies?: () => Set<string>
  /** none: never strike first; near: only one at arm's length; range: any within GUARD_RANGE. */
  aggression?: () => Aggression
  /** A spot held (the side's chest): enemies within DEFEND_RANGE of it are fought too. */
  defend?: () => Vec3 | undefined
  /** The creeper (by entity id) this courtier is to lure away from the hall; the manager chooses. */
  lure?: () => number | undefined
  /** Done with that creeper: gone, far off, or it blew up. */
  lured?: (id: number) => void
  /** The home spot, and the hall's doorway (its column), for leading a creeper out and away. */
  home?: () => Vec3 | undefined
  doorway?: () => { x: number; z: number } | undefined
  /** Take food out of the storehouse: how many it took; undefined when it cannot go now (busy). */
  fetchFood: () => Promise<number | undefined>
  /** Say something in character (the brain words it). */
  speak: (instruction: string, fallback: string) => Promise<unknown>
}

/**
 * A courtier looking after itself in survival: eating when hungry, and, for guards, fighting off
 * the monsters that come near the royal family. Bot.tick calls `tick` every few seconds.
 */
export class Survival {
  private readonly bot: SurvivalBot
  private eating = false
  private fighting = false
  private fleeing = false
  private lastEmptyTrip = 0
  /** Monsters that got away, left alone until then (no chasing the same one every tick). */
  private readonly letGo = new Map<number, number>()
  private lastHungryWords = 0

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly opts: SurvivalOptions
  ) {
    this.bot = bot as SurvivalBot
  }

  /** Fighting, eating or out of a creeper's way: leave the body alone for now. */
  get busy(): boolean {
    return this.fighting || this.eating || this.fleeing
  }

  /** What it is busy with, for whoever waits on it. */
  get busyWith(): string | undefined {
    if (this.fighting) return 'fighting'
    if (this.eating) return 'eating'
    if (this.fleeing) return "out of a creeper's way"
    return undefined
  }

  async tick(): Promise<void> {
    if (!this.bot.entity) return
    if (!this.fighting && (await this.lureCreeper())) return
    if (!this.fighting && (await this.awayFromCreepers())) return
    if (!this.fighting) {
      const foe = (this.opts.guard ? this.foe() : undefined) ?? this.enemy()
      if (foe) await this.fight(foe)
    }
    if (!this.fighting) await this.eatIfHungry()
  }

  /**
   * The nearest player of the other side to be fought (the war game): one at arm's length when
   * only striking back, any within reach when fighting, and any near the spot held.
   */
  private enemy(): ReturnType<typeof this.monsters>[number] | undefined {
    const names = this.opts.enemies?.()
    const aggression = this.opts.aggression?.() ?? 'none'
    if (!names?.size || aggression === 'none') return undefined
    const me = this.bot.entity.position
    const held = this.opts.defend?.()
    const now = Date.now()
    return Object.values(this.bot.entities)
      .filter(
        (e) =>
          e !== this.bot.entity &&
          e.type === 'player' &&
          e.isValid !== false &&
          names.has((e.username ?? '').toLowerCase()) &&
          (this.letGo.get(e.id) ?? 0) < now
      )
      .filter((e) => {
        const gap = e.position.distanceTo(me)
        if (gap <= STRIKE + 1) return true
        if (aggression !== 'range') return false
        return (
          gap <= GUARD_RANGE || (held !== undefined && held.distanceTo(e.position) <= DEFEND_RANGE)
        )
      })
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  }

  /**
   * The nearest monster close to a royal or to this guard. Inside the hall, with no royal to
   * defend, a guard fights only what got in or comes within reach: going out after the monsters
   * round the walls at night opened the door to them, and the guards died out there.
   */
  private foe(): ReturnType<typeof this.monsters>[number] | undefined {
    const me = this.bot.entity.position
    const royals = this.opts.royals()
    const now = Date.now()
    const indoors = this.opts.inside?.(me.floored()) ?? false
    return this.monsters()
      .filter((e) => (this.letGo.get(e.id) ?? 0) < now)
      .filter((e) => {
        const gap = e.position.distanceTo(me)
        // Near a royal, and near enough to this guard to be reached.
        if (gap <= GUARD_RANGE && royals.some((r) => r.distanceTo(e.position) <= GUARD_RANGE))
          return true
        if (indoors) return gap <= STRIKE + 1 || this.opts.inside!(e.position.floored())
        return gap <= SELF_RANGE
      })
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  }

  private monsters() {
    return Object.values(this.bot.entities).filter(
      (e) =>
        e !== this.bot.entity && e.name !== undefined && HOSTILE.test(e.name) && e.isValid !== false
    )
  }

  /** Go after the monster and strike until it is gone, far away, or the fight runs too long. */
  private async fight(foe: ReturnType<typeof this.monsters>[number]): Promise<void> {
    this.fighting = true
    const what = foe.type === 'player' ? (foe.username ?? 'an enemy') : `a ${foe.name}`
    this.log.info(`fighting ${what} at ${foe.position.floored()}`)
    let strikes = 0
    let outcome = 'gave up after 30 seconds'
    try {
      await this.takeUpWeapon()
      const start = Date.now()
      // Closest it has come, and when: a monster it cannot get nearer to is out of reach.
      let closest = Infinity
      let closer = Date.now()
      while (Date.now() - start < FIGHT_MS) {
        if (!this.bot.entities[foe.id] || foe.isValid === false) {
          outcome = 'it is gone'
          break
        }
        const gap = foe.position.distanceTo(this.bot.entity.position)
        if (gap > GUARD_RANGE + 6) {
          outcome = 'it got away'
          this.letGo.set(foe.id, Date.now() + 60_000)
          break
        }
        if (gap < closest - 0.5) {
          closest = gap
          closer = Date.now()
        } else if (Date.now() - closer > OUT_OF_REACH_MS) {
          outcome = 'out of reach'
          this.letGo.set(foe.id, Date.now() + 60_000)
          break
        }
        if (gap > STRIKE) {
          this.bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1.5), true)
          await sleep(300)
          continue
        }
        await this.bot.lookAt(foe.position.offset(0, (foe.height ?? 1.8) * 0.8, 0)).catch(() => {})
        this.bot.attack(foe)
        strikes++
        // The weapon needs a moment to swing back for full damage.
        await sleep(650)
      }
    } catch (err) {
      outcome = `broke off: ${errMsg(err)}`
    } finally {
      this.bot.pathfinder.setGoal(null)
      this.fighting = false
      if (outcome.startsWith('gave up')) this.letGo.set(foe.id, Date.now() + 60_000)
      this.log.info(`fight with ${what}: ${strikes} strikes, ${outcome}`)
    }
  }

  /**
   * The lure: go to meet the creeper the manager named, so it takes notice, then lead it out
   * past where it stood and far from home, till it is far off or has lost interest. At the
   * courtier's own risk (the King's rule, 2026-11-03: a creeper in the hall is a serious
   * matter, worth a courtier). Returns whether it is at it.
   */
  private async lureCreeper(): Promise<boolean> {
    const id = this.opts.lure?.()
    if (id === undefined) return false
    const creeper = this.bot.entities[id]
    const home = this.opts.home?.()
    const gone = () => {
      const c = this.bot.entities[id]
      return !c || c.isValid === false
    }
    if (gone() || !home) {
      this.opts.lured?.(id)
      return false
    }
    const me = () => this.bot.entity.position
    const fromHome = (p: Vec3) => Math.hypot(p.x - home.x, p.z - home.z)
    this.fleeing = true
    try {
      this.log.info(`luring the creeper at ${creeper.position.floored()} away from the hall`)
      // Towards it, so it takes notice (it chases a player it sees within sixteen blocks), but
      // never within its fuse: it blows up three blocks off, a second and a half after it starts.
      if (creeper.position.distanceTo(me()) > 9) {
        this.bot.pathfinder.setGoal(new goals.GoalFollow(creeper, 8), true)
        const t0 = Date.now()
        while (Date.now() - t0 < 10_000 && !gone() && creeper.position.distanceTo(me()) > 9)
          await sleep(250)
        this.bot.pathfinder.setGoal(null)
      }
      if (gone()) return true
      // Then away: out past it, far from home; and on, away from it, if it is still at heel.
      // One that does not follow is gone back to, close enough to take notice, and led again.
      let to = leadPoint(home, me(), creeper.position)
      this.bot.pathfinder.setGoal(new goals.GoalNear(to.x, to.y, to.z, 2))
      const t1 = Date.now()
      while (Date.now() - t1 < 150_000 && !gone()) {
        const c = this.bot.entities[id]
        const gap = c.position.distanceTo(me())
        // Done only once it has lost track and is off home's doorstep: a lure that turned for
        // home with the creeper seven blocks behind was caught on the way (2026-11-03).
        if (gap > 14) {
          if (fromHome(c.position) >= CREEPER_WATCH) break
          this.bot.pathfinder.setGoal(new goals.GoalFollow(c, 7), true)
          const t2 = Date.now()
          while (Date.now() - t2 < 8_000 && !gone() && c.position.distanceTo(me()) > 8)
            await sleep(250)
          if (gone()) break
          to = leadPoint(home, me(), c.position)
          this.bot.pathfinder.setGoal(new goals.GoalNear(to.x, to.y, to.z, 2))
          continue
        }
        // At the point with it at heel: further out still, never back towards home.
        if (me().distanceTo(new Vec3(to.x, to.y, to.z)) < 3) {
          to = leadPoint(home, me(), c.position)
          this.bot.pathfinder.setGoal(new goals.GoalNear(to.x, to.y, to.z, 2))
        }
        await sleep(250)
      }
      const c = this.bot.entities[id]
      this.log.info(
        gone() || !c
          ? 'the creeper is gone'
          : `the creeper is ${Math.round(fromHome(c.position))} blocks from home now`
      )
      return true
    } finally {
      this.bot.pathfinder.setGoal(null)
      this.fleeing = false
      this.opts.lured?.(id)
    }
  }

  /**
   * Out of a creeper's way: it blows up three blocks off, and nobody fights one. Not inside the
   * hall, whose walls take the blast, unless one got in: then everyone leaves by the doorway,
   * so it follows them out instead of blowing up the chest. Returns whether it had to move.
   */
  private async awayFromCreepers(): Promise<boolean> {
    const me = this.bot.entity.position
    // Inside the hall the walls keep them off, unless one got in (spawned in a dark room) or
    // stands right by the doorway.
    const inside = this.opts.inside
    const indoors = inside?.(me.floored()) ?? false
    const creeper = Object.values(this.bot.entities).find((e) => {
      if (e.name !== 'creeper' || e.isValid === false) return false
      const gap = e.position.distanceTo(me)
      return indoors ? inside!(e.position.floored()) || gap <= 4 : gap <= CREEPER_NEAR
    })
    if (!creeper) return false
    this.fleeing = true
    // At arm's length already: run first, straight away from it, and think after (a creeper
    // blows up three blocks off after a second and a half; the pathfinder takes its time).
    if (creeper.position.distanceTo(me) <= DASH_WITHIN) {
      const dx = me.x - creeper.position.x
      const dz = me.z - creeper.position.z
      const k = 6 / Math.max(Math.hypot(dx, dz), 0.5)
      try {
        await this.bot.lookAt(me.offset(dx * k, 1.6, dz * k), true)
        this.bot.setControlState('sprint', true)
        this.bot.setControlState('forward', true)
        await sleep(DASH_MS)
      } finally {
        this.bot.setControlState('forward', false)
        this.bot.setControlState('sprint', false)
      }
    }
    const alive = () =>
      this.bot.entities[creeper.id] !== undefined &&
      creeper.isValid !== false &&
      creeper.position.distanceTo(this.bot.entity.position) < CREEPER_SAFE
    try {
      const door = this.opts.doorway?.()
      const home = this.opts.home?.()
      const got_in = indoors && inside!(creeper.position.floored())
      if (got_in && door && home) {
        const doorCell = new Vec3(door.x, home.y, door.z)
        if (creeper.position.distanceTo(doorCell) > 2.5) {
          // Out by the doorway, then on away from it.
          this.log.info(`a creeper in the hall at ${creeper.position.floored()}: leaving it`)
          const out = doorCell.offset(Math.sign(door.x - home.x), 0, Math.sign(door.z - home.z))
          this.bot.pathfinder.setGoal(new goals.GoalBlock(out.x, out.y, out.z))
          const t0 = Date.now()
          while (Date.now() - t0 < 8_000 && alive() && inside!(this.bot.entity.position.floored()))
            await sleep(250)
        }
      } else this.log.info(`backing away from a creeper at ${creeper.position.floored()}`)
      // Clear of every creeper in sight, not only this one: on 2026-11-03 three courtiers
      // fleeing one creeper ran out of the doorway into another.
      const all = Object.values(this.bot.entities).filter(
        (e) =>
          e.name === 'creeper' &&
          e.isValid !== false &&
          e.position.distanceTo(this.bot.entity.position) <= CREEPER_WATCH
      )
      const away = new goals.GoalCompositeAll(
        (all.length ? all : [creeper]).map(
          (c) => new goals.GoalInvert(new goals.GoalFollow(c, CREEPER_SAFE))
        )
      )
      this.bot.pathfinder.setGoal(away, true)
      const start = Date.now()
      while (Date.now() - start < 8_000 && alive()) await sleep(250)
    } finally {
      this.bot.pathfinder.setGoal(null)
      this.fleeing = false
    }
    return true
  }

  private async takeUpWeapon(): Promise<void> {
    for (const kind of WEAPONS) {
      const weapon = this.bot.inventory.items().find((i) => kind.test(i.name))
      if (!weapon) continue
      if (this.bot.heldItem?.name !== weapon.name)
        await this.bot.equip(weapon, 'hand').catch(() => {})
      return
    }
  }

  /** Eat when hungry; fetch food from the storehouse if there is none; say so if none there either. */
  private async eatIfHungry(): Promise<void> {
    const food = this.bot.food
    // Health only comes back above 18 food: hurt, eat up to that; else only when hungry.
    const hurt = (this.bot.health ?? 20) < 20
    if (food === undefined || this.eating) return
    if (food >= (hurt ? HEAL : HUNGRY)) return
    let item = this.bestFood()
    // After a trip that found nothing, wait a while before looking again.
    if (!item && Date.now() - this.lastEmptyTrip > 5 * 60_000) {
      const took = await this.opts.fetchFood().catch(() => 0)
      // Busy just now: eat later, and say nothing.
      if (took === undefined) return
      if (took > 0) this.log.info(`took ${took} food from the storehouse`)
      else this.lastEmptyTrip = Date.now()
      item = this.bestFood()
    }
    if (!item) {
      if (food >= HUNGRY) return
      if (Date.now() - this.lastHungryWords > 15 * 60_000) {
        this.lastHungryWords = Date.now()
        this.log.info(`hungry (food ${food}) and nothing to eat`)
        // One of the court says it now and then, not every courtier every quarter of an hour.
        if (Date.now() - hungerSaid < HUNGER_WORDS_MS) return
        hungerSaid = Date.now()
        await this.opts.speak(
          'You are hungry and have nothing to eat, and there is no food in the storehouse. Say ' +
            'so in one short, light-hearted sentence, in character.',
          'My stomach is grumbling, and there is nothing to eat!'
        )
      }
      return
    }
    this.eating = true
    try {
      await this.bot.equip(item, 'hand')
      await withTimeout(this.bot.consume(), 6_000)
      this.log.info(`ate ${item.name} (food ${food} -> ${this.bot.food})`)
    } catch (err) {
      this.log.info(`could not eat ${item.name}: ${errMsg(err)}`)
    } finally {
      this.eating = false
    }
  }

  private bestFood() {
    const items = this.bot.inventory.items().filter((i) => FOOD.test(i.name))
    return items.sort((a, b) => FOODS.indexOf(a.name) - FOODS.indexOf(b.name))[0]
  }

  /** Close an open door close by that nobody is passing through (no monsters let in). */
  async closeDoors(): Promise<void> {
    if (this.busy || this.bot.pathfinder.isMoving()) return
    const me = this.bot.entity.position
    const doors = this.bot.findBlocks({
      matching: (b: { name: string }) => /_door$/.test(b.name) && !/iron_door/.test(b.name),
      maxDistance: 4,
      count: 4,
    })
    for (const p of doors) {
      const door = this.bot.blockAt(p)
      const props = door?.getProperties?.() as
        { open_bit?: boolean | number; upper_block_bit?: boolean | number } | undefined
      if (!door || !props || props.upper_block_bit || !props.open_bit) continue
      const inDoorway = Object.values(this.bot.entities).some(
        (e) =>
          e.position &&
          Math.floor(e.position.x) === p.x &&
          Math.floor(e.position.z) === p.z &&
          Math.abs(e.position.y - p.y) < 2
      )
      if (inDoorway || me.distanceTo(p.offset(0.5, 0, 0.5)) < 1.2) continue
      try {
        await this.bot.activateBlock(door)
        this.log.info(`closed the door at ${p}`)
      } catch (err) {
        this.log.debug(`could not close the door at ${p}: ${errMsg(err)}`)
      }
    }
  }
}

/** Is it night (monsters about)? Bedrock day is 0..24000; night from dusk to dawn. */
/**
 * Hours for work outdoors: from when the sun is well up (the night's monsters burned) till well
 * before dusk, as an errand may take five minutes (6000 ticks) and dusk killed those still out.
 */
export function outdoorHours(timeOfDay: number | undefined): boolean {
  if (timeOfDay === undefined) return true
  const t = ((timeOfDay % 24000) + 24000) % 24000
  return t >= 500 && t <= 9_000
}

/** Dusk has fallen (or it is not yet light): whoever is out comes home. */
export function duskFallen(timeOfDay: number | undefined): boolean {
  if (timeOfDay === undefined) return false
  const t = ((timeOfDay % 24000) + 24000) % 24000
  return t >= 11_500 || t < 300
}

export function isNight(timeOfDay: number | undefined): boolean {
  if (timeOfDay === undefined) return false
  const t = ((timeOfDay % 24000) + 24000) % 24000
  return t >= 12_500 && t <= 23_500
}

export { Vec3 }
