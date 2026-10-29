import type { EventEmitter } from 'node:events'
import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { Movements, goals, pathfinder, type Pathfinder } from 'mineflayer-pathfinder'
import type { Logger } from '../logger'

/** What the bot is doing with its legs right now. */
export type Activity =
  | { kind: 'following'; target: string }
  | { kind: 'coming'; target: string }
  | { kind: 'going'; target: string }
  | null

export type MoveResult = 'ok' | 'not_visible'

/** Stay this close (blocks) when following, and stop this close when coming. */
const FOLLOW_DISTANCE = 2
const COME_DISTANCE = 2

/** mineflayer-pathfinder is typed against Java mineflayer's Bot; mineflayer-bedrock's is API-identical. */
type PathfinderBot = MineflayerBot & { pathfinder: Pathfinder }

/**
 * Walking for one connected bot, built on mineflayer-pathfinder. The bots never change the
 * princess's world while moving: no digging through blocks, no towering or bridging with
 * placed blocks.
 */
export class Movement {
  private activity: Activity = null
  private doors = false
  private readonly bot: PathfinderBot
  private readonly stuck = new StuckDetector()
  /** Following on duty rather than on request: do not announce being stuck. */
  private quiet = false
  /** Called once when the bot cannot find a way to the player it is walking to. */
  onStuck?: (target: string) => void

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger
  ) {
    this.bot = bot as PathfinderBot
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.loadPlugin(pathfinder as any)
    // The pathfinder's events are not in mineflayer-bedrock's typed event map.
    const events = bot as unknown as EventEmitter
    events.on('goal_reached', () => {
      if (this.activity?.kind === 'coming' || this.activity?.kind === 'going') {
        this.log.info(`arrived at ${this.activity.target}`)
        this.activity = null
      }
    })
    // Tread water: the pathfinder only holds jump in water while it is walking a path, so an
    // idle or blocked bot would sink to the bottom. Hold jump whenever in water or lava (the
    // physics engine lifts the bot a little each tick), and let go once out.
    let floating = false
    this.bot.on('physicsTick', () => {
      const entity = this.bot.entity as unknown as { isInWater?: boolean; isInLava?: boolean }
      const inLiquid = Boolean(entity?.isInWater || entity?.isInLava)
      if (inLiquid) {
        this.bot.setControlState('jump', true)
        if (!floating) this.log.info('in water: swimming up')
        floating = true
      } else if (floating) {
        floating = false
        this.bot.setControlState('jump', false)
      }
    })
    events.on('path_update', (result: { status: string }) => {
      const change = this.stuck.update(result.status)
      // No way to a spot (home): give up; whoever sent the bot tries another way.
      if (change === 'stuck' && this.activity?.kind === 'going') {
        this.log.info(`cannot find a way ${this.activity.target}`)
        this.stop()
        return
      }
      const target = this.activity?.target
      if (change === 'stuck' && target) {
        this.log.info(`cannot find a way to ${target}; waiting for them to come within reach`)
        if (!this.quiet) this.onStuck?.(target)
      } else if (change === 'unstuck' && target) {
        this.log.info(`found a way to ${target} again`)
      }
    })
  }

  /**
   * Call once the bot has spawned and the world around it has loaded. `doors`: walk through
   * doors (survival, where the court's hall has one; the bots close them behind them).
   */
  configure(doors = this.doors): void {
    this.doors = doors
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const movements = new Movements(this.bot as any)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.scafoldingBlocks = []
    movements.allowParkour = true
    movements.allowSprinting = true
    movements.canOpenDoors = doors
    // Survival (doors): no drop that hurts; a fall of more than three blocks costs health.
    if (doors) movements.maxDropDown = 3
    this.bot.pathfinder.setMovements(movements)
  }

  current(): Activity {
    return this.activity
  }

  /** Human-readable activity for the brain's prompt, e.g. "following LittleOne42". */
  describe(): string | null {
    return this.activity ? `${this.activity.kind} ${this.activity.target}` : null
  }

  /** Keep walking after a player until told to stop. */
  follow(player: string, opts: { distance?: number; quiet?: boolean } = {}): MoveResult {
    const entity = this.bot.players[player]?.entity
    if (!entity) return 'not_visible'
    this.stuck.reset()
    this.quiet = opts.quiet ?? false
    this.activity = { kind: 'following', target: player }
    this.bot.pathfinder.setGoal(
      new goals.GoalFollow(entity, opts.distance ?? FOLLOW_DISTANCE),
      true
    )
    this.log.info(`following ${player}`)
    return 'ok'
  }

  /** Walk to where a player is now, then stop. */
  comeTo(player: string): MoveResult {
    const entity = this.bot.players[player]?.entity
    if (!entity) return 'not_visible'
    this.stuck.reset()
    this.activity = { kind: 'coming', target: player }
    const { x, y, z } = entity.position
    this.bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, COME_DISTANCE))
    this.log.info(`walking to ${player}`)
    return 'ok'
  }

  /** Walk to a spot ("home"), then stop. */
  goTo(spot: { x: number; y: number; z: number }, label: string): void {
    this.stuck.reset()
    this.quiet = true
    this.activity = { kind: 'going', target: label }
    this.bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, 3))
    this.log.info(`walking ${label}`)
  }

  stop(): void {
    if (this.activity) this.log.info(`stopped ${this.describe()}`)
    this.activity = null
    this.stuck.reset()
    this.bot.pathfinder.setGoal(null)
  }

  /** Stop if the given player was the one we were walking to or after. */
  forget(player: string): void {
    if (this.activity && this.activity.target.toLowerCase() === player.toLowerCase()) this.stop()
  }
}

/** Path searches that must fail in a row before the bot counts as stuck. */
export const STUCK_AFTER_FAILURES = 5

/**
 * Turns the pathfinder's stream of path results into two events: 'stuck' once after several
 * failed searches in a row, and 'unstuck' once a path is found again.
 */
export class StuckDetector {
  private failures = 0
  private reported = false

  update(status: string): 'stuck' | 'unstuck' | null {
    if (status === 'noPath' || status === 'timeout') {
      this.failures++
      if (!this.reported && this.failures >= STUCK_AFTER_FAILURES) {
        this.reported = true
        return 'stuck'
      }
      return null
    }
    this.failures = 0
    if (this.reported) {
      this.reported = false
      return 'unstuck'
    }
    return null
  }

  reset(): void {
    this.failures = 0
    this.reported = false
  }
}
