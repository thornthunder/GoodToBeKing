import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, withTimeout } from '../util'

/** Walking out to look further: this far a leg, at most this many legs, this long each. */
export const SCOUT_STEP = 64
export const SCOUT_LEGS = 4
const SCOUT_MS = 60_000

/**
 * Where the court last found something by scouting, and which way it scouts next: kept for
 * each kind of thing looked for (trees, game), shared by all the court's bots.
 */
const found = new Map<string, Vec3>()
const turns = new Map<string, number>()

/** Note where the court found what it looks for (the next search starts there). */
export function foundAt(what: string, p: Vec3): void {
  found.set(what, p.clone())
}

/**
 * Nothing in sight: walk out to see more land. On the first leg, to where the court last found
 * it (if that is far); then SCOUT_STEP blocks a leg, straight on outward (a square of legs
 * only came back home). The next search heads a quarter turn on.
 */
export async function scout(
  bot: MineflayerBot,
  log: Logger,
  what: string,
  leg: number
): Promise<void> {
  const walker = bot as MineflayerBot & { pathfinder: Pathfinder }
  const me = bot.entity.position
  const last = found.get(what)
  let to: Vec3
  if (leg === 0 && last && last.distanceTo(me) > 32) to = last
  else {
    const angle = (turns.get(what) ?? 0) * (Math.PI / 2)
    to = me.offset(Math.cos(angle) * SCOUT_STEP, 0, Math.sin(angle) * SCOUT_STEP)
  }
  if (leg === SCOUT_LEGS - 1) turns.set(what, (turns.get(what) ?? 0) + 1)
  log.info(`no ${what} in sight: looking further, towards ${to.floored()}`)
  try {
    await withTimeout(
      walker.pathfinder.goto(new goals.GoalNearXZ(Math.floor(to.x), Math.floor(to.z), 8)),
      SCOUT_MS
    )
  } catch (err) {
    walker.pathfinder.setGoal(null)
    log.debug(`scouting stopped: ${errMsg(err)}`)
  }
}
