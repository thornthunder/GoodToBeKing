import type { EventEmitter } from 'node:events'
import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { Movements, goals, pathfinder, type Pathfinder } from 'mineflayer-pathfinder'
import type { Logger } from '../logger'

/** What the bot is doing with its legs right now. */
export type Activity =
  { kind: 'following'; target: string } | { kind: 'coming'; target: string } | null

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
  private readonly bot: PathfinderBot

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
      if (this.activity?.kind === 'coming') {
        this.log.info(`arrived at ${this.activity.target}`)
        this.activity = null
      }
    })
    events.on('path_update', (result: { status: string }) => {
      if (result.status === 'noPath' || result.status === 'timeout') {
        this.log.debug(`pathfinder: ${result.status} while ${this.describe() ?? 'idle'}`)
      }
    })
  }

  /** Call once the bot has spawned and the world around it has loaded. */
  configure(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const movements = new Movements(this.bot as any)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.scafoldingBlocks = []
    movements.allowParkour = true
    movements.allowSprinting = true
    movements.canOpenDoors = false
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
  follow(player: string): MoveResult {
    const entity = this.bot.players[player]?.entity
    if (!entity) return 'not_visible'
    this.activity = { kind: 'following', target: player }
    this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, FOLLOW_DISTANCE), true)
    this.log.info(`following ${player}`)
    return 'ok'
  }

  /** Walk to where a player is now, then stop. */
  comeTo(player: string): MoveResult {
    const entity = this.bot.players[player]?.entity
    if (!entity) return 'not_visible'
    this.activity = { kind: 'coming', target: player }
    const { x, y, z } = entity.position
    this.bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, COME_DISTANCE))
    this.log.info(`walking to ${player}`)
    return 'ok'
  }

  stop(): void {
    if (this.activity) this.log.info(`stopped ${this.describe()}`)
    this.activity = null
    this.bot.pathfinder.setGoal(null)
  }

  /** Stop if the given player was the one we were walking to or after. */
  forget(player: string): void {
    if (this.activity && this.activity.target.toLowerCase() === player.toLowerCase()) this.stop()
  }
}
