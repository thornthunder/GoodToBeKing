import type { Bot as MineflayerBot } from 'mineflayer-bedrock'
import { goals, type Pathfinder } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Logger } from '../logger'
import { errMsg, sleep, withTimeout } from '../util'

/** What a courtier eats, best first. */
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
]
const FOOD = new RegExp(`^(${FOODS.join('|')})$`)

/** Monsters the guards fight. Creepers and endermen are left alone: fighting them goes badly. */
export const HOSTILE =
  /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|spider|cave_spider|witch|pillager|vindicator|slime|phantom|silverfish|zoglin|hoglin|piglin_brute)$/
const WEAPONS = [/_sword$/, /_axe$/]

/** Eat below this much food (of 20): low enough not to nibble all day. */
export const HUNGRY = 14
/** Guards look this far around a royal (or themselves) for monsters. */
const GUARD_RANGE = 12
const SELF_RANGE = 6
/** Melee reach. */
const STRIKE = 3
/** The longest one fight may last. */
const FIGHT_MS = 30_000

type SurvivalBot = MineflayerBot & { pathfinder: Pathfinder }

export interface SurvivalOptions {
  /** A guard defends the royal family (duty: escort). */
  guard: boolean
  /** Where royals stand right now (the ones in sight). */
  royals: () => Vec3[]
  /** Take food out of the storehouse: returns how many it took. */
  fetchFood: () => Promise<number>
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
  private lastFoodTrip = 0
  private lastHungryWords = 0

  constructor(
    bot: MineflayerBot,
    private readonly log: Logger,
    private readonly opts: SurvivalOptions
  ) {
    this.bot = bot as SurvivalBot
  }

  /** Fighting or eating: leave the body alone for now. */
  get busy(): boolean {
    return this.fighting || this.eating
  }

  async tick(): Promise<void> {
    if (!this.bot.entity) return
    if (this.opts.guard && !this.fighting) {
      const foe = this.foe()
      if (foe) await this.fight(foe)
    }
    if (!this.fighting) await this.eatIfHungry()
  }

  /** The nearest monster close to a royal or to this guard. */
  private foe(): ReturnType<typeof this.monsters>[number] | undefined {
    const me = this.bot.entity.position
    const royals = this.opts.royals()
    return this.monsters()
      .filter(
        (e) =>
          e.position.distanceTo(me) <= SELF_RANGE ||
          royals.some((r) => r.distanceTo(e.position) <= GUARD_RANGE)
      )
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
    this.log.info(`fighting a ${foe.name} at ${foe.position.floored()}`)
    try {
      await this.takeUpWeapon()
      const start = Date.now()
      while (Date.now() - start < FIGHT_MS && this.bot.entities[foe.id] && foe.isValid !== false) {
        const gap = foe.position.distanceTo(this.bot.entity.position)
        if (gap > GUARD_RANGE + 6) break
        if (gap > STRIKE) {
          this.bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1.5), true)
          await sleep(300)
          continue
        }
        await this.bot.lookAt(foe.position.offset(0, (foe.height ?? 1.8) * 0.8, 0)).catch(() => {})
        this.bot.attack(foe)
        // The weapon needs a moment to swing back for full damage.
        await sleep(650)
      }
    } catch (err) {
      this.log.info(`fight broke off: ${errMsg(err)}`)
    } finally {
      this.bot.pathfinder.setGoal(null)
      this.fighting = false
    }
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
    if (food === undefined || food >= HUNGRY || this.eating) return
    let item = this.bestFood()
    if (!item && Date.now() - this.lastFoodTrip > 5 * 60_000) {
      this.lastFoodTrip = Date.now()
      const took = await this.opts.fetchFood().catch(() => 0)
      if (took > 0) this.log.info(`took ${took} food from the storehouse`)
      item = this.bestFood()
    }
    if (!item) {
      if (Date.now() - this.lastHungryWords > 15 * 60_000) {
        this.lastHungryWords = Date.now()
        this.log.info(`hungry (food ${food}) and nothing to eat`)
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
export function isNight(timeOfDay: number | undefined): boolean {
  if (timeOfDay === undefined) return false
  const t = ((timeOfDay % 24000) + 24000) % 24000
  return t >= 12_500 && t <= 23_500
}

export { Vec3 }
