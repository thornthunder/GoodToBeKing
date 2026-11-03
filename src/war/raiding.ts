import type { Chest, Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Point } from '../build/site'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'
import { total, type Tactic } from './War'

/**
 * The raid, as one courtier carries it out (src/war/War.ts for the game): a raider walks to the
 * enemy's chest, takes all it can carry, walks home and puts it in its own side's chest, and
 * goes again; a defender holds its side's chest, and puts back what falls to the ground by it.
 * Fighting is the Survival's (bot/survival.ts): an enemy of the other side within reach is
 * fought like a monster, as the courtier's aggression allows.
 */

/** Kept in the pockets: what the courtier fights and works with, never loot. */
export const GEAR =
  /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(fishing_rod|shield)$/

/** How far one leg of a long walk goes, and how long it may take. */
const LEG = 48
const LEG_MS = 90_000
/** A walk that got nowhere this many times running: no way there, for now. */
const STUCK_LEGS = 3
/**
 * No way to their chest this many times (a rest between): the raider gives up. On 2026-11-02
 * both sides gave up within half a minute of the order; a raid may last two days.
 */
const NO_WAY_TRIES = 8
const NO_WAY_REST_MS = 30_000
/** A chest not where it was said to be is looked for this close by (the court remakes a lost one beside it). */
const CHEST_SEARCH = 8
/** A "wait" raider holds this far from the chest, this long at most, for the defenders to leave. */
const WAIT_OFF = 24
const WAIT_MS = 4 * 60_000
const WAIT_CLEAR = 10
/** Fighting first: this long at most before the chest is gone for anyway. */
const FIGHT_FIRST_MS = 2 * 60_000
/** The enemy's chest found empty this many times running: nothing more to take. */
const EMPTY_TRIPS = 2
/** Dead: waiting this long at most to wake up at home. */
const RESPAWN_MS = 5 * 60_000
/** Drops this close to the defended chest are picked up and put back. */
const DROP_RANGE = 8

export type Aggression = 'none' | 'near' | 'range'

type Walker = MineflayerBot & { pathfinder: Pathfinder }

export interface RaidBody {
  bot: MineflayerBot
  log: Logger
  /** Walk to the chest, open it, do the work (the gatherer's). */
  withChest: (chest: Point, work: (window: Chest) => Promise<number>) => Promise<number>
  /** Spawned and not dead right now. */
  alive: () => boolean
  /** Fighting or eating: the body is taken. */
  busy: () => boolean
  /** What with (for the log, when the wait drags on). */
  busyWith?: () => string | undefined
  /** Enemies in sight, by name. */
  enemies: () => Array<{ name: string; position: Vec3 }>
  /**
   * Down a hole with no way on: dig steps out towards a spot until there is a way to the goal
   * (bot/escape.ts). The steps climbed, or -1 when there is no way.
   */
  climbOut?: (toward: Point, goal: goals.Goal) => Promise<number>
  /**
   * When it last died (ms). A Bedrock courtier wakes at home within a fifth of a second of
   * dying, so `alive()` alone misses most deaths: the raider went on as if it still carried the
   * loot, and nothing was ever booked as lost (series 1 and 2, 2026-11-03).
   */
  lastDeath?: () => number
  /** The chest at a spot, or the nearest one this close by; none seen: undefined. */
  findChest?: (near: Point, radius: number) => Point | undefined
}

export interface RaidOrders {
  chest: Point
  store: Point
  tactic: Tactic
  trips: number
  onGrab: (items: Record<string, number>) => void
  onDeposit: (items: Record<string, number>) => void
  onLost: () => void
  onDone: (why: string) => void
}

const fmt = (p: Point) => `(${p.x}, ${p.y}, ${p.z})`

/** What the courtier carries that is not gear, by item. */
export function pockets(bot: MineflayerBot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of bot.inventory.items())
    if (!GEAR.test(item.name)) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

/** What grew between two looks in the pockets. */
export function grew(
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, n] of Object.entries(after)) {
    const k = n - (before[name] ?? 0)
    if (k > 0) out[name] = k
  }
  return out
}

/** What shrank between two looks in the pockets. */
export function shrank(
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> {
  return grew(after, before)
}

export class Raider {
  private stop = false
  /** How the Survival may fight right now. */
  aggression: Aggression = 'none'
  /** Walking toward the enemy's chest with nothing taken yet. */
  private outward = false

  constructor(
    private readonly body: RaidBody,
    private readonly orders: RaidOrders
  ) {}

  cancel(): void {
    this.stop = true
    ;(this.body.bot as Walker).pathfinder.setGoal(null)
  }

  async run(): Promise<void> {
    const { bot, log } = this.body
    const o = this.orders
    let trips = 0
    let empties = 0
    let failures = 0
    let carrying: Record<string, number> = {}
    try {
      while (!this.stop && trips < o.trips) {
        if (!this.body.alive()) {
          if (total(carrying) > 0) {
            o.onLost()
            carrying = {}
          }
          if (!(await this.waitAlive())) return o.onDone('dead, and did not wake in time')
          continue
        }
        // Out: as the tactic has it.
        this.outward = true
        this.aggression = o.tactic === 'fight' ? 'range' : o.tactic === 'wait' ? 'near' : 'none'
        const near =
          o.tactic === 'wait' ? await this.walk(o.chest, WAIT_OFF) : await this.walk(o.chest, 3)
        if (!near) {
          if (!this.body.alive()) continue
          if (++failures >= NO_WAY_TRIES) return o.onDone('no way to their chest')
          log.info(`no way to their chest yet (try ${failures} of ${NO_WAY_TRIES}); resting`)
          await sleep(NO_WAY_REST_MS)
          continue
        }
        failures = 0
        if (o.tactic === 'wait' && !(await this.waitForOpening())) continue
        if (o.tactic === 'fight') await this.fightFirst()
        if (this.stop || !this.body.alive()) continue
        // Take all that fits (from a chest remade beside the one said, if that one is gone).
        const before = pockets(bot)
        let opened = false
        const theirs = this.body.findChest?.(o.chest, CHEST_SEARCH) ?? o.chest
        if (theirs !== o.chest)
          log.info(`their chest is not where it was said: one at ${fmt(theirs)}`)
        await this.body.withChest(theirs, async (window) => {
          opened = true
          for (const item of window.containerItems()) {
            if (this.stop || bot.inventory.emptySlotCount() < 1) break
            await withTimeout(window.withdraw(item.type, item.metadata, item.count), 5_000).catch(
              () => {}
            )
          }
          return 0
        })
        if (!this.body.alive()) continue
        const taken = grew(before, pockets(bot))
        this.outward = false
        if (!opened) {
          log.info('could not get at their chest')
          if (++failures >= STUCK_LEGS) return o.onDone('could not get at their chest')
          await sleep(5_000)
          continue
        }
        if (total(taken) === 0) {
          log.info('their chest is empty')
          if (++empties >= EMPTY_TRIPS) return o.onDone('their chest is empty')
          await sleep(30_000)
          continue
        }
        empties = 0
        trips++
        for (const [n, k] of Object.entries(taken)) carrying[n] = (carrying[n] ?? 0) + k
        log.info(`took ${total(taken)} things from their chest (trip ${trips})`)
        o.onGrab(taken)
        const tookAt = Date.now()
        const killed = () => (this.body.lastDeath?.() ?? 0) > tookAt
        // Home with it: struck on the way, strike back.
        this.aggression = 'near'
        for (let attempt = 0; attempt < STUCK_LEGS && !this.stop; attempt++) {
          if (await this.walk(o.store, 3)) break
          if (!this.body.alive() || killed()) break
          await sleep(5_000)
        }
        if (!this.body.alive()) continue
        // Killed on the way, and awake at home already: the loot lies where it fell.
        if (killed()) {
          log.info('killed on the way home: the loot is lost')
          if (total(carrying) > 0) o.onLost()
          carrying = {}
          continue
        }
        const ours = this.body.findChest?.(o.store, CHEST_SEARCH) ?? o.store
        // Only what the chest took counts: pockets emptied by a death on the way are loot lost,
        // not loot brought (on 2026-11-03 a raider killed by the enemy chest was credited with
        // all it carried, a second after taking it, 190 blocks from home).
        const put: Record<string, number> = {}
        await this.body.withChest(ours, async (window) => {
          for (const item of bot.inventory.items())
            if (!GEAR.test(item.name))
              await withTimeout(window.deposit(item.type, item.metadata, item.count), 5_000)
                .then(() => (put[item.name] = (put[item.name] ?? 0) + item.count))
                .catch(() => {})
          return 0
        })
        if (total(put) > 0) {
          log.info(`put ${total(put)} things in our chest`)
          o.onDeposit(put)
          for (const [n, k] of Object.entries(put)) {
            carrying[n] = (carrying[n] ?? 0) - k
            if (carrying[n] <= 0) delete carrying[n]
          }
        } else log.info('could not put the loot in our chest; trying again next trip')
      }
      o.onDone(this.stop ? 'the raid was called off' : `${trips} trip(s) done`)
    } catch (err) {
      log.warn(`the raid broke off: ${errMsg(err)}`)
      o.onDone(`broke off: ${errMsg(err)}`)
    } finally {
      this.aggression = 'none'
      ;(bot as Walker).pathfinder.setGoal(null)
    }
  }

  /** Raiding, and not yet at the chest: what the Survival asks before fighting on the way. */
  get onTheWay(): boolean {
    return this.outward
  }

  /** Wait (dead) to wake up again. */
  private async waitAlive(): Promise<boolean> {
    const start = Date.now()
    while (!this.stop && Date.now() - start < RESPAWN_MS) {
      await sleep(2_000)
      if (this.body.alive()) {
        await sleep(3_000)
        return true
      }
    }
    return false
  }

  /**
   * Walk to within `reach` of a spot, a leg at a time (a path across the land is found leg by
   * leg; the pathfinder gives up on a far goal). Returns whether it got there.
   */
  private async walk(to: Point, reach: number): Promise<boolean> {
    const { bot, log } = this.body
    const walker = bot as Walker
    const target = new Vec3(to.x, to.y, to.z)
    let stuck = 0
    while (!this.stop && this.body.alive()) {
      // Fighting, eating or fleeing: wait, saying so now and then; a body busy for minutes on
      // end is stuck (on 2026-11-03 a raider stood "raiding" at home for half an hour): go on.
      for (let waited = 0; this.body.busy() && !this.stop; waited++) {
        if (waited >= 120) {
          log.warn(`busy (${this.body.busyWith?.() ?? '?'}) for two minutes: going on regardless`)
          break
        }
        if (waited > 0 && waited % 30 === 0)
          log.info(`waiting to walk on: busy ${this.body.busyWith?.() ?? '?'} (${waited} s)`)
        await sleep(1_000)
      }
      const me = bot.entity.position
      const gap = me.distanceTo(target)
      if (gap <= reach) return true
      const last = gap <= LEG
      const leg = last ? target : me.plus(target.minus(me).scaled(LEG / gap)).floored()
      const goal = last
        ? new goals.GoalNear(leg.x, leg.y, leg.z, reach)
        : new goals.GoalNearXZ(leg.x, leg.z, 6)
      try {
        await withTimeout(walker.pathfinder.goto(goal), LEG_MS)
      } catch (err) {
        walker.pathfinder.setGoal(null)
        if (this.body.busy()) continue
        const moved = bot.entity.position.distanceTo(me)
        log.info(`a leg of the walk stopped (${errMsg(err)}); moved ${Math.round(moved)}`)
        // Got nowhere: down a hole, maybe (woken in a crater at home). Dig steps out.
        if (moved < 4 && this.body.climbOut) {
          const climbed = await this.body.climbOut({ x: leg.x, y: leg.y, z: leg.z }, goal)
          if (climbed > 0) {
            stuck = 0
            continue
          }
        }
        if (moved < 4 && ++stuck >= STUCK_LEGS) return false
        await sleep(2_000)
      }
    }
    return false
  }

  /** Hold off until no defender stands by the chest, or the wait has been long enough. */
  private async waitForOpening(): Promise<boolean> {
    const { log } = this.body
    const chest = new Vec3(this.orders.chest.x, this.orders.chest.y, this.orders.chest.z)
    const start = Date.now()
    log.info('waiting for the defenders to leave their chest')
    while (!this.stop && this.body.alive()) {
      const guards = this.body.enemies().filter((e) => e.position.distanceTo(chest) <= WAIT_CLEAR)
      if (!guards.length || Date.now() - start > WAIT_MS) {
        log.info(
          guards.length ? 'waited long enough: going in' : 'the chest is unguarded: going in'
        )
        this.aggression = 'near'
        return await this.walk(this.orders.chest, 3)
      }
      await sleep(5_000)
    }
    return false
  }

  /** Let the Survival fight what stands by the chest, a while. */
  private async fightFirst(): Promise<void> {
    const chest = new Vec3(this.orders.chest.x, this.orders.chest.y, this.orders.chest.z)
    const start = Date.now()
    this.aggression = 'range'
    while (!this.stop && this.body.alive() && Date.now() - start < FIGHT_FIRST_MS) {
      const guards = this.body.enemies().filter((e) => e.position.distanceTo(chest) <= WAIT_CLEAR)
      if (!guards.length && !this.body.busy()) return
      await sleep(2_000)
    }
  }
}

export interface DefenceOrders {
  chest: Point
  onRecovered: (items: Record<string, number>) => void
}

export class Defender {
  private stop = false
  readonly aggression: Aggression = 'range'

  constructor(
    private readonly body: RaidBody,
    private readonly orders: DefenceOrders
  ) {}

  cancel(): void {
    this.stop = true
    ;(this.body.bot as Walker).pathfinder.setGoal(null)
  }

  /** Stand by the chest; pick up what lies near it and put it back; the Survival fights. */
  async run(): Promise<void> {
    const { bot, log } = this.body
    const walker = bot as Walker
    const chest = new Vec3(this.orders.chest.x, this.orders.chest.y, this.orders.chest.z)
    log.info(`holding the chest at ${chest}`)
    try {
      while (!this.stop) {
        if (!this.body.alive() || this.body.busy()) {
          await sleep(2_000)
          continue
        }
        const me = bot.entity.position
        if (me.distanceTo(chest) > 5) {
          try {
            await withTimeout(
              walker.pathfinder.goto(new goals.GoalNear(chest.x, chest.y, chest.z, 3)),
              60_000
            )
          } catch {
            walker.pathfinder.setGoal(null)
          }
          continue
        }
        const drops = Object.values(bot.entities).filter(
          (e) => e.name === 'item' && e.position.distanceTo(chest) <= DROP_RANGE
        )
        if (drops.length) {
          const before = pockets(bot)
          for (const drop of drops.slice(0, 6)) {
            if (this.stop || this.body.busy()) break
            const p = drop.position
            try {
              await withTimeout(
                walker.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)),
                10_000
              )
            } catch {
              walker.pathfinder.setGoal(null)
            }
          }
          await sleep(500)
          const found = grew(before, pockets(bot))
          if (total(found) > 0) {
            const put: Record<string, number> = {}
            await this.body.withChest(this.orders.chest, async (window) => {
              for (const item of bot.inventory.items())
                if (found[item.name])
                  await withTimeout(window.deposit(item.type, item.metadata, item.count), 5_000)
                    .then(() => (put[item.name] = (put[item.name] ?? 0) + item.count))
                    .catch(() => {})
              return 0
            })
            if (total(put) > 0) {
              log.info(`put ${total(put)} things found by the chest back`)
              this.orders.onRecovered(put)
            }
          }
        }
        await sleep(3_000)
      }
    } catch (err) {
      log.warn(`the defence broke off: ${errMsg(err)}`)
    } finally {
      walker.pathfinder.setGoal(null)
    }
  }
}
