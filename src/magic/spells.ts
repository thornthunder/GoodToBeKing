/**
 * Merlin's magic: spells made of a few safe building blocks (teleport, effect, weather, time,
 * summon, particle, sound, gift, saddle). The model only ever picks a spell and its target, place,
 * item or creature; the commands are built here, from allowlists, and nothing it writes is ever
 * run as a command. Merlin needs operator rights for them (and the world needs cheats on).
 */

/** Whom a step works on: the one the spell is cast on, the one who asked, Merlin, or the court. */
export type Who = 'target' | 'requester' | 'merlin' | 'court'

/** Where a teleport goes: to someone, or to the named place the request gives, or a fixed place. */
export type Where = Who | 'place' | { place: string }

export const EFFECTS = {
  night_vision: { max: 600 },
  water_breathing: { max: 600 },
  slow_falling: { max: 300 },
  levitation: { max: 5 },
  regeneration: { max: 30 },
  instant_health: { max: 1 },
  speed: { max: 300 },
  jump_boost: { max: 300 },
  fire_resistance: { max: 600 },
} as const
export type Effect = keyof typeof EFFECTS

/** Friendly creatures only. */
export const CREATURES = [
  'horse',
  'donkey',
  'cat',
  'parrot',
  'rabbit',
  'fox',
  'axolotl',
  'allay',
  'sheep',
  'cow',
  'pig',
  'chicken',
  'turtle',
  'frog',
  'fireworks_rocket',
] as const
export type Creature = (typeof CREATURES)[number]

/**
 * Gifts, with how many may be given at once. They are taken back after a day. Food and building
 * materials help the court in survival, but sparingly: see MAGIC_PER_HOUR.
 */
export const GIFTS: Record<string, number> = {
  cake: 1,
  cookie: 8,
  bread: 4,
  apple: 4,
  golden_apple: 1,
  sweet_berries: 8,
  poppy: 4,
  dandelion: 4,
  cornflower: 4,
  allium: 4,
  oxeye_daisy: 4,
  azure_bluet: 4,
  lily_of_the_valley: 4,
  pink_tulip: 4,
  red_tulip: 4,
  firework_rocket: 8,
  lead: 1,
  name_tag: 1,
  cooked_beef: 4,
  cooked_chicken: 4,
  cooked_cod: 4,
  baked_potato: 4,
  carrot: 4,
  oak_log: 10,
  oak_planks: 10,
  cobblestone: 10,
  coal: 8,
  torch: 8,
  wheat_seeds: 8,
  oak_sapling: 4,
  crafting_table: 1,
  furnace: 1,
  chest: 1,
  bed: 6,
  iron_sword: 1,
}

/**
 * The King's rule: Merlin's magic does at most this much in any real hour, all spells together.
 * Each thing conjured (a gift, a creature, a saddle) counts one; any other casting (weather, time,
 * an effect, sparkles) counts one; travel spells are free. See castingCost.
 */
export const MAGIC_PER_HOUR = 10

/** Thrown when a spell would do more than is left of this hour's magic. */
export class MagicSpent extends Error {
  constructor() {
    super('the magic is spent for this hour')
  }
}

export const PARTICLES = [
  'minecraft:villager_happy',
  'minecraft:heart_particle',
  'minecraft:totem_particle',
  'minecraft:endrod',
] as const
export type Particle = (typeof PARTICLES)[number]

export const SOUNDS = [
  'random.levelup',
  'random.orb',
  'firework.twinkle',
  'beacon.activate',
] as const
export type Sound = (typeof SOUNDS)[number]

export type Step =
  | { kind: 'teleport'; who: Who; to: Where }
  | { kind: 'effect'; who: Who; effect: Effect | '$effect'; seconds: number; amplifier?: number }
  | { kind: 'weather'; weather: 'clear' | 'rain' }
  | { kind: 'time'; time: 'day' | 'noon' | 'sunset' | 'night' }
  | { kind: 'summon'; creature: Creature | '$creature'; at: Who; count: number }
  | { kind: 'particle'; particle: Particle; at: Who }
  | { kind: 'sound'; sound: Sound; at: Who }
  /** A gift: given now, taken back after a day. */
  | { kind: 'give'; who: Who; item: string; count: number }
  /** Saddles the nearest horse without a saddle by the one it is for; taken back after a day. */
  | { kind: 'saddle'; who: Who }

export interface Spell {
  /** "blink" */
  id: string
  /** "Blink" */
  name: string
  /** What it does, for the model: "Merlin appears beside the one who asks." */
  does: string
  steps: Step[]
  /** Who taught it, for spells learned from the King. */
  learnedFrom?: string
}

/** What a request fills in: on whom, to where, which item or creature or effect. */
export interface SpellArgs {
  target?: string
  place?: string
  item?: string
  /** How many were asked for (a gift, creatures); their own limits and the hour's still apply. */
  count?: number
  creature?: string
  effect?: string
}

/** Travel (teleports, with sparkles or sounds at most) is free of the hourly limit. */
export function isTravel(spell: Spell): boolean {
  return (
    spell.steps.some((s) => s.kind === 'teleport') &&
    spell.steps.every((s) => s.kind === 'teleport' || s.kind === 'particle' || s.kind === 'sound')
  )
}

/** Conjures things that count one by one: gifts, saddles, creatures (not a fireworks show). */
export function conjures(spell: Spell): boolean {
  return spell.steps.some(
    (s) =>
      s.kind === 'give' ||
      s.kind === 'saddle' ||
      (s.kind === 'summon' && s.creature !== 'fireworks_rocket')
  )
}

/**
 * What one casting costs of the hour's magic besides the things it conjures (which count one by
 * one): travel nothing, a spell that only conjures nothing more, any other spell one.
 */
export function castingCost(spell: Spell): number {
  if (isTravel(spell)) return 0
  const plain = spell.steps.some(
    (s) =>
      s.kind === 'weather' ||
      s.kind === 'time' ||
      s.kind === 'effect' ||
      (s.kind === 'summon' && s.creature === 'fireworks_rocket')
  )
  return plain || !conjures(spell) ? 1 : 0
}

/** The spells Merlin knows from the start. */
export const BUILTIN_SPELLS: Spell[] = [
  {
    id: 'blink',
    name: 'Blink',
    does: 'Merlin appears beside the one it is cast on (the one who asks, unless another is named).',
    steps: [{ kind: 'teleport', who: 'merlin', to: 'target' }],
  },
  {
    id: 'summon_to_me',
    name: 'Summoning',
    does: 'Brings the one named (a royal or a courtier) to the one who asks.',
    steps: [{ kind: 'teleport', who: 'target', to: 'requester' }],
  },
  {
    id: 'portal',
    name: 'Portal',
    does: 'Sends the one it is cast on to a named place of the castles.',
    steps: [{ kind: 'teleport', who: 'target', to: 'place' }],
  },
  {
    id: 'gather',
    name: 'Gathering',
    does: 'Brings the whole court to the one who asks.',
    steps: [{ kind: 'teleport', who: 'court', to: 'requester' }],
  },
  {
    id: 'heal',
    name: 'Healing',
    does: 'Heals the one it is cast on.',
    steps: [
      { kind: 'effect', who: 'target', effect: 'instant_health', seconds: 1 },
      { kind: 'effect', who: 'target', effect: 'regeneration', seconds: 10, amplifier: 1 },
      { kind: 'particle', particle: 'minecraft:heart_particle', at: 'target' },
    ],
  },
  ...(
    [
      [
        'night_sight',
        'Night Sight',
        'Lets the one it is cast on see in the dark for five minutes.',
        'night_vision',
        300,
      ],
      [
        'fish_breath',
        'Fish Breath',
        'Lets the one it is cast on breathe under water for five minutes.',
        'water_breathing',
        300,
      ],
      [
        'feather_fall',
        'Feather Fall',
        'Makes the one it is cast on fall softly as a feather for a minute.',
        'slow_falling',
        60,
      ],
      [
        'float',
        'Floating',
        'Lifts the one it is cast on gently into the air for a few seconds.',
        'levitation',
        3,
      ],
      ['swiftness', 'Swiftness', 'Makes the one it is cast on run fast for a minute.', 'speed', 60],
      ['bounce', 'Bounce', 'Lets the one it is cast on jump high for a minute.', 'jump_boost', 60],
      [
        'fire_ward',
        'Fire Ward',
        'Keeps fire and lava from hurting the one it is cast on for three minutes.',
        'fire_resistance',
        180,
      ],
    ] as const
  ).map(([id, name, does, effect, seconds]): Spell => ({
    id,
    name,
    does,
    steps: [
      {
        kind: 'effect',
        who: 'target',
        effect,
        seconds,
        amplifier: effect === 'speed' || effect === 'jump_boost' ? 1 : 0,
      },
      { kind: 'particle', particle: 'minecraft:totem_particle', at: 'target' },
    ],
  })),
  {
    id: 'fair_weather',
    name: 'Fair Weather',
    does: 'Clears the sky.',
    steps: [{ kind: 'weather', weather: 'clear' }],
  },
  {
    id: 'rain',
    name: 'Rainfall',
    does: 'Brings a gentle rain.',
    steps: [{ kind: 'weather', weather: 'rain' }],
  },
  ...(
    [
      ['morning', 'Dawn', 'Makes it morning.', 'day'],
      ['noon', 'High Sun', 'Makes it midday.', 'noon'],
      ['sunset', 'Dusk', 'Makes the sun set.', 'sunset'],
      ['night', 'Nightfall', 'Makes it night.', 'night'],
    ] as const
  ).map(([id, name, does, time]): Spell => ({ id, name, does, steps: [{ kind: 'time', time }] })),
  {
    id: 'fireworks',
    name: 'Fireworks',
    does: 'Sets off fireworks around the one it is cast on.',
    steps: [
      { kind: 'summon', creature: 'fireworks_rocket', at: 'target', count: 3 },
      { kind: 'sound', sound: 'firework.twinkle', at: 'target' },
    ],
  },
  {
    id: 'sparkles',
    name: 'Sparkles',
    does: 'Makes sparkles and a merry chime around the one it is cast on.',
    steps: [
      { kind: 'particle', particle: 'minecraft:villager_happy', at: 'target' },
      { kind: 'particle', particle: 'minecraft:endrod', at: 'target' },
      { kind: 'sound', sound: 'random.levelup', at: 'target' },
    ],
  },
  {
    id: 'summon_creature',
    name: 'Summon Creature',
    does: `Calls a friendly creature to the one it is cast on (creature: ${CREATURES.filter((c) => c !== 'fireworks_rocket').join(', ')}).`,
    steps: [
      { kind: 'summon', creature: '$creature', at: 'target', count: 1 },
      { kind: 'particle', particle: 'minecraft:villager_happy', at: 'target' },
    ],
  },
  {
    id: 'gift',
    name: 'Magic Gift',
    does: `Gives the one it is cast on a magic gift that fades after a day, as many as asked within limits (item: ${Object.keys(GIFTS).join(', ')}).`,
    steps: [
      { kind: 'give', who: 'target', item: '$item', count: 1 },
      { kind: 'sound', sound: 'random.orb', at: 'target' },
    ],
  },
  {
    id: 'saddle',
    name: 'Magic Saddle',
    does: 'Puts a magic saddle on the horse next to the one it is cast on; it fades after a day.',
    steps: [
      { kind: 'saddle', who: 'target' },
      { kind: 'sound', sound: 'random.orb', at: 'target' },
    ],
  },
]

const isWho = (w: unknown): w is Who =>
  w === 'target' || w === 'requester' || w === 'merlin' || w === 'court'

/**
 * Problems with a spell's steps, in plain sentences (empty when it is sound). Learned spells come
 * from the model, so everything is checked against the allowlists.
 */
export function spellProblems(steps: unknown, places: string[] = []): string[] {
  if (!Array.isArray(steps) || steps.length === 0) return ['a spell needs at least one step']
  if (steps.length > 8) return ['a spell may have at most eight steps']
  const problems: string[] = []
  for (const [i, raw] of steps.entries()) {
    const s = raw as Record<string, unknown>
    const at = `step ${i + 1}`
    switch (s.kind) {
      case 'teleport': {
        if (!isWho(s.who)) problems.push(`${at}: teleport whom?`)
        // A fixed place is written by name, either bare or as { place }.
        const to = s.to as Where | string
        const name = typeof to === 'object' && to !== null ? to.place : to
        const placeOk = typeof name === 'string' && places.includes(name)
        if (!isWho(to) && to !== 'place' && !placeOk) problems.push(`${at}: teleport to where?`)
        break
      }
      case 'effect': {
        const effect = EFFECTS[s.effect as Effect]
        if (!isWho(s.who)) problems.push(`${at}: an effect on whom?`)
        if (!effect && s.effect !== '$effect')
          problems.push(`${at}: unknown effect ${String(s.effect)}`)
        if (typeof s.seconds !== 'number' || s.seconds < 1 || (effect && s.seconds > effect.max))
          problems.push(`${at}: the effect lasts 1 to ${effect?.max ?? 600} seconds`)
        if (s.amplifier !== undefined && s.amplifier !== 0 && s.amplifier !== 1)
          problems.push(`${at}: the strength is 0 or 1`)
        break
      }
      case 'weather':
        if (s.weather !== 'clear' && s.weather !== 'rain')
          problems.push(`${at}: weather is clear or rain`)
        break
      case 'time':
        if (!['day', 'noon', 'sunset', 'night'].includes(s.time as string))
          problems.push(`${at}: time is day, noon, sunset or night`)
        break
      case 'summon':
        if (!CREATURES.includes(s.creature as Creature) && s.creature !== '$creature')
          problems.push(`${at}: only friendly creatures can be summoned`)
        if (!isWho(s.at)) problems.push(`${at}: summon by whom?`)
        if (typeof s.count !== 'number' || s.count < 1 || s.count > 3)
          problems.push(`${at}: summon one to three`)
        break
      case 'particle':
        if (!PARTICLES.includes(s.particle as Particle)) problems.push(`${at}: unknown sparkle`)
        if (!isWho(s.at)) problems.push(`${at}: sparkles by whom?`)
        break
      case 'sound':
        if (!SOUNDS.includes(s.sound as Sound)) problems.push(`${at}: unknown sound`)
        if (!isWho(s.at)) problems.push(`${at}: a sound for whom?`)
        break
      case 'give': {
        const max = GIFTS[s.item as string]
        if (!max && s.item !== '$item')
          problems.push(`${at}: ${String(s.item)} is not a gift Merlin may give`)
        if (!isWho(s.who) || s.who === 'court') problems.push(`${at}: a gift for whom?`)
        if (typeof s.count !== 'number' || s.count < 1 || (max && s.count > max))
          problems.push(`${at}: at most ${max ?? 1} at once`)
        break
      }
      case 'saddle':
        if (!isWho(s.who) || s.who === 'court') problems.push(`${at}: a saddle for whom?`)
        break
      default:
        problems.push(`${at}: Merlin knows no magic of the kind "${String(s.kind)}"`)
    }
  }
  return problems
}

/** What a step needs from the request: a place, an item, a creature or an effect. */
export function needs(spell: Spell): Array<keyof SpellArgs> {
  const out = new Set<keyof SpellArgs>()
  for (const s of spell.steps) {
    if (s.kind === 'teleport' && s.to === 'place') out.add('place')
    if (s.kind === 'give' && s.item === '$item') out.add('item')
    if (s.kind === 'summon' && s.creature === '$creature') out.add('creature')
    if (s.kind === 'effect' && s.effect === '$effect') out.add('effect')
  }
  return [...out]
}

/** A command for the server, and what to do about the gift it hands out (if any). */
export interface Cast {
  command: string
  /** Set on a gift: how to take it back after a day. */
  undo?: string[]
  /** Set on a saddle: the tag command must find a horse, or the spell fails. */
  mustFind?: string
  /** How many things it conjures (each counted against MAGIC_PER_HOUR). */
  items?: number
}

export interface CastContext {
  requester: string
  target: string
  merlin: string
  court: string[]
  /** A named place's standing spot, for teleports to a place. */
  placeOf: (name: string | undefined) => { x: number; y: number; z: number } | undefined
  args: SpellArgs
  /** A fresh id per cast, for tagging what a gift is put on. */
  giftId: string
  /** Things that may still be conjured this hour (no limit when unset). */
  magicLeft?: number
}

const q = (name: string) => `"${name.replace(/"/g, '')}"`

/** The commands for a spell, in order. Throws when an argument is missing or not allowed. */
export function commandsFor(spell: Spell, ctx: CastContext): Cast[] {
  const whom = (w: Who): string[] =>
    w === 'court'
      ? ctx.court
      : [w === 'merlin' ? ctx.merlin : w === 'requester' ? ctx.requester : ctx.target]
  const out: Cast[] = []
  let left = ctx.magicLeft ?? Infinity
  for (const step of spell.steps) {
    switch (step.kind) {
      case 'teleport': {
        const to = step.to
        const spot =
          to === 'place'
            ? ctx.placeOf(ctx.args.place)
            : typeof to === 'object'
              ? ctx.placeOf(to.place)
              : undefined
        const dest =
          to === 'place' || typeof to === 'object'
            ? spot && `${Math.floor(spot.x) + 0.5} ${spot.y} ${Math.floor(spot.z) + 0.5}`
            : q(whom(to)[0])
        if (!dest) throw new Error('that place is not known')
        for (const who of whom(step.who)) {
          if (typeof to === 'string' && to !== 'place' && who === whom(to)[0]) continue
          out.push({ command: `tp ${q(who)} ${dest}` })
        }
        break
      }
      case 'effect': {
        const effect = step.effect === '$effect' ? (ctx.args.effect as Effect) : step.effect
        const limit = EFFECTS[effect]
        if (!limit) throw new Error(`no such effect: ${String(ctx.args.effect)}`)
        const seconds = Math.min(step.seconds, limit.max)
        for (const who of whom(step.who))
          out.push({ command: `effect ${q(who)} ${effect} ${seconds} ${step.amplifier ?? 0} true` })
        break
      }
      case 'weather':
        out.push({ command: `weather ${step.weather}` })
        break
      case 'time':
        out.push({ command: `time set ${step.time}` })
        break
      case 'summon': {
        const creature = step.creature === '$creature' ? ctx.args.creature : step.creature
        if (!creature || !CREATURES.includes(creature as Creature))
          throw new Error(`no such creature: ${String(creature)}`)
        // A fireworks show is one spell; creatures count one by one, three at most at a time.
        const show = creature === 'fireworks_rocket'
        const asked = step.creature === '$creature' && ctx.args.count ? ctx.args.count : step.count
        for (const who of whom(step.at)) {
          const count = show ? step.count : Math.min(Math.floor(asked), 3, left)
          if (count < 1) throw new MagicSpent()
          if (!show) left -= count
          for (let i = 0; i < count; i++) {
            const dx = (i % 3) - 1
            out.push({
              command: `execute at ${q(who)} run summon ${creature} ~${dx} ~ ~1`,
              ...(show ? {} : { items: 1 }),
            })
          }
        }
        break
      }
      case 'particle':
        for (const who of whom(step.at))
          out.push({ command: `execute at ${q(who)} run particle ${step.particle} ~ ~1 ~` })
        break
      case 'sound':
        for (const who of whom(step.at)) out.push({ command: `playsound ${step.sound} ${q(who)}` })
        break
      case 'give': {
        const item = step.item === '$item' ? ctx.args.item : step.item
        const max = item ? GIFTS[item] : undefined
        if (!item || !max) throw new Error(`not a gift Merlin may give: ${String(item)}`)
        const asked = step.item === '$item' && ctx.args.count ? ctx.args.count : step.count
        for (const who of whom(step.who)) {
          const count = Math.min(Math.floor(asked), max, left)
          if (count < 1) throw new MagicSpent()
          left -= count
          out.push({
            command: `give ${q(who)} ${item} ${count}`,
            undo: [`clear ${q(who)} ${item} -1 ${count}`],
            items: count,
          })
        }
        break
      }
      case 'saddle': {
        const tag = `merlin_gift_${ctx.giftId}`
        for (const who of whom(step.who)) {
          if (left < 1) throw new MagicSpent()
          left -= 1
          const find =
            `execute at ${q(who)} run tag @e[type=horse,r=8,c=1,` +
            `hasitem={item=saddle,quantity=0}] add ${tag}`
          out.push({ command: find, mustFind: tag })
          out.push({
            command: `replaceitem entity @e[tag=${tag}] slot.saddle 0 saddle`,
            items: 1,
            undo: [
              // A horse keeps its saddle in slot 0 of its own inventory, and stays saddled until
              // the game's own event says otherwise (emptying "slot.saddle" does neither).
              `replaceitem entity @e[tag=${tag}] slot.inventory 0 air`,
              `event entity @e[tag=${tag}] minecraft:horse_unsaddled`,
              `tag @e[tag=${tag}] remove ${tag}`,
            ],
          })
        }
        break
      }
    }
  }
  return out
}

/** How spells are built, for the model that writes down a spell the King teaches. */
export function stepGuide(): string[] {
  return [
    '- teleport {who, to}: who is "target", "requester", "merlin" or "court"; to is one of those,',
    '  "place" (the place named when the spell is cast), or a place name from the list',
    `- effect {who, effect, seconds, amplifier 0 or 1}: effect is one of ${Object.keys(EFFECTS).join(', ')}`,
    '- weather {weather}: clear or rain. time {time}: day, noon, sunset or night',
    `- summon {creature, at, count 1 to 3}: creature is one of ${CREATURES.join(', ')}`,
    `- particle {particle, at}: one of ${PARTICLES.join(', ')}`,
    `- sound {sound, at}: one of ${SOUNDS.join(', ')}`,
    `- give {who, item, count}: a gift that fades after a day; item is one of ${Object.keys(GIFTS).join(', ')}`,
    '- saddle {who}: a magic saddle on their horse, fading after a day',
    '"target" is the one the spell is cast on, "requester" the one who asks for it.',
  ]
}

/**
 * Tidy the steps of a spell the King describes, as the model wrote them: one thing per step (a
 * sound or a sparkle written onto another step becomes a step of its own), only the fields each
 * kind has, and "the one it is cast on" wherever whom or where was left out.
 */
export function tidySteps(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  const out: unknown[] = []
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue
    const s = r as Record<string, unknown>
    const who = typeof s.who === 'string' ? s.who : typeof s.at === 'string' ? s.at : 'target'
    const pick = (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]))
    switch (s.kind) {
      case 'teleport':
        out.push({ kind: 'teleport', who, to: s.to ?? 'requester' })
        break
      case 'effect':
        out.push({ kind: 'effect', who, ...pick(['effect', 'seconds', 'amplifier']) })
        break
      case 'weather':
        out.push({ kind: 'weather', ...pick(['weather']) })
        break
      case 'time':
        out.push({ kind: 'time', ...pick(['time']) })
        break
      case 'summon':
        out.push({ kind: 'summon', at: who, count: s.count ?? 1, ...pick(['creature']) })
        break
      case 'give':
        out.push({ kind: 'give', who, count: s.count ?? 1, ...pick(['item']) })
        break
      case 'saddle':
        out.push({ kind: 'saddle', who })
        break
      case 'particle':
      case 'sound':
        break // added below, from their own fields
      default:
        out.push({ kind: s.kind })
    }
    if (typeof s.particle === 'string')
      out.push({ kind: 'particle', particle: s.particle, at: who })
    if (typeof s.sound === 'string') out.push({ kind: 'sound', sound: s.sound, at: who })
  }
  return out
}
