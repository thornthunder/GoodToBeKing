/**
 * The commands a running court understands (BotManager.runCommand), as forms for the admin, and
 * the lines they become in the world's command file. Everything is checked here before it is
 * written: one line, known bots, words the court's parser reads as meant.
 * src/admin/commands.test.ts checks these lists against the court's own.
 */
export const BLUEPRINTS = ['tower', 'arch', 'garden', 'castle']
export const MATERIALS = ['dirt', 'wood', 'sand', 'gravel']
export const HALL_WORKS = [
  'roof',
  'floor',
  'light',
  'door',
  'beds',
  'repair',
  'furnace',
  'chest',
  'reinforce',
]
export const BUILTIN_SPELLS = [
  'blink',
  'summon_to_me',
  'portal',
  'gather',
  'heal',
  'night_sight',
  'fish_breath',
  'feather_fall',
  'float',
  'swiftness',
  'bounce',
  'fire_ward',
  'fair_weather',
  'rain',
  'morning',
  'noon',
  'sunset',
  'night',
  'fireworks',
  'sparkles',
  'summon_creature',
  'gift',
  'saddle',
]

export type FieldKind = 'select' | 'int' | 'point' | 'player' | 'word' | 'place' | 'text'

export interface CommandField {
  name: string
  label: string
  kind: FieldKind
  options?: string[]
  /** Options the admin fills in from the world: its spells, its castle designs. */
  source?: 'spells' | 'designs'
  optional?: boolean
  help?: string
}

export interface CommandVerb {
  verb: string
  label: string
  help: string
  group: string
  /** Who it is for: any bot, Merlin (magic), or the court as a whole. */
  who: 'bot' | 'magic' | 'household' | 'works'
  fields: CommandField[]
}

const FOR: CommandField = {
  name: 'for',
  label: 'As if asked by',
  kind: 'player',
  optional: true,
  help: 'A royal’s player name; empty: the court’s own.',
}
const AT: CommandField = { name: 'at', label: 'At x y z', kind: 'point' }

export const VERBS: CommandVerb[] = [
  // Survival work by hand.
  {
    verb: 'fetch',
    group: 'Survival work',
    who: 'bot',
    label: 'Fetch a material',
    help: 'Dig it by hand from untouched land and bring it back (to the royal, or into the storehouse).',
    fields: [
      { name: 'material', label: 'Material', kind: 'select', options: MATERIALS },
      { name: 'count', label: 'How many', kind: 'int', optional: true },
      FOR,
    ],
  },
  {
    verb: 'hall',
    group: 'Survival work',
    who: 'bot',
    label: 'Work on the hall',
    help: 'By hand, on the court’s home hall.',
    fields: [{ name: 'work', label: 'Work', kind: 'select', options: HALL_WORKS }, FOR],
  },
  {
    verb: 'hunt',
    group: 'Survival work',
    who: 'bot',
    label: 'Hunt',
    help: 'For the court’s food, by the King’s rule (never named, tame or baby animals).',
    fields: [{ name: 'count', label: 'Animals', kind: 'int', optional: true }],
  },
  {
    verb: 'cook',
    group: 'Survival work',
    who: 'bot',
    label: 'Cook',
    help: 'The storehouse’s raw meat, at a furnace near home.',
    fields: [],
  },
  {
    verb: 'farm',
    group: 'Survival work',
    who: 'bot',
    label: 'Farm',
    help: 'Sow, harvest and bake at the court’s field.',
    fields: [],
  },
  {
    verb: 'forest',
    group: 'Survival work',
    who: 'bot',
    label: 'Tend the grove',
    help: 'Fell grown trees and plant again.',
    fields: [],
  },
  {
    verb: 'fish',
    group: 'Survival work',
    who: 'bot',
    label: 'Fish',
    help: 'At the court’s fishing water.',
    fields: [],
  },
  {
    verb: 'mine',
    group: 'Survival work',
    who: 'bot',
    label: 'Mine',
    help: 'In the court’s branch mine.',
    fields: [{ name: 'count', label: 'Blocks wanted', kind: 'int', optional: true }],
  },
  {
    verb: 'charcoal',
    group: 'Survival work',
    who: 'bot',
    label: 'Make charcoal',
    help: 'From the storehouse’s logs, for torches.',
    fields: [],
  },
  {
    verb: 'arm',
    group: 'Survival work',
    who: 'bot',
    label: 'Arm',
    help: 'Make and put on the best sword and armour the storehouse allows.',
    fields: [],
  },
  {
    verb: 'bed',
    group: 'Survival work',
    who: 'bot',
    label: 'Go to bed',
    help: 'As when a royal lies down at night.',
    fields: [],
  },
  // Building (creative).
  {
    verb: 'build',
    group: 'Building',
    who: 'bot',
    label: 'Build a blueprint',
    help: 'Creative only: raise a small build at that spot.',
    fields: [
      { name: 'blueprint', label: 'Blueprint', kind: 'select', options: BLUEPRINTS },
      AT,
      FOR,
    ],
  },
  {
    verb: 'resume',
    group: 'Building',
    who: 'bot',
    label: 'Resume a build',
    help: 'Finish a blueprint that stands half built at that corner.',
    fields: [
      { name: 'blueprint', label: 'Blueprint', kind: 'select', options: BLUEPRINTS },
      AT,
      { name: 'turns', label: 'Turns', kind: 'int', optional: true },
      FOR,
    ],
  },
  {
    verb: 'commission',
    group: 'Building',
    who: 'bot',
    label: 'Commission a build',
    help: 'As if a royal asked this bot: the Castellan hands it to a builder.',
    fields: [
      { name: 'blueprint', label: 'Blueprint', kind: 'select', options: BLUEPRINTS },
      { ...AT, optional: true, help: 'Empty: where the royal stands.' },
      FOR,
    ],
  },
  {
    verb: 'undo',
    group: 'Building',
    who: 'bot',
    label: 'Take down the last build',
    help: 'The blocks this bot placed for its last build.',
    fields: [FOR],
  },
  // Magic.
  {
    verb: 'cast',
    group: 'Magic',
    who: 'magic',
    label: 'Cast a spell',
    help: 'Within the hour’s ten (travel is free).',
    fields: [
      { name: 'spell', label: 'Spell', kind: 'select', source: 'spells' },
      { name: 'on', label: 'On', kind: 'player', optional: true, help: 'Empty: the one asking.' },
      {
        name: 'to',
        label: 'To place',
        kind: 'place',
        optional: true,
        help: 'A named place, e.g. home or the storehouse.',
      },
      { name: 'item', label: 'Item', kind: 'word', optional: true },
      { name: 'count', label: 'Count', kind: 'int', optional: true },
      { name: 'creature', label: 'Creature', kind: 'word', optional: true },
      { name: 'effect', label: 'Effect', kind: 'word', optional: true },
      FOR,
    ],
  },
  {
    verb: 'spells',
    group: 'Magic',
    who: 'magic',
    label: 'List spells, places and gifts',
    help: 'Written to the log.',
    fields: [],
  },
  {
    verb: 'fade',
    group: 'Magic',
    who: 'magic',
    label: 'Take every gift back now',
    help: 'Gifts fade after a day anyway.',
    fields: [],
  },
  {
    verb: 'run',
    group: 'Magic',
    who: 'magic',
    label: 'Run a server command',
    help: 'Developer tool: a raw command as Merlin (an operator).',
    fields: [
      {
        name: 'command',
        label: 'Command',
        kind: 'text',
        help: 'Without the slash, e.g. time set day.',
      },
    ],
  },
  // The court as a whole.
  {
    verb: 'home',
    group: 'Household',
    who: 'household',
    label: 'Declare a home',
    help: 'As if that royal declared it: the court moves house, surveys and reports.',
    fields: [AT, FOR],
  },
  {
    verb: 'storehouse',
    group: 'Household',
    who: 'household',
    label: 'Set the storehouse',
    help: 'The chest the court keeps its things in.',
    fields: [AT, FOR],
  },
  {
    verb: 'status',
    group: 'Castle works',
    who: 'works',
    label: 'Works status',
    help: 'Written to the log.',
    fields: [],
  },
  {
    verb: 'pause',
    group: 'Castle works',
    who: 'works',
    label: 'Pause the works',
    help: '',
    fields: [],
  },
  {
    verb: 'resume-works',
    group: 'Castle works',
    who: 'works',
    label: 'Resume the works',
    help: '',
    fields: [],
  },
  {
    verb: 'plan',
    group: 'Castle works',
    who: 'works',
    label: 'Plan the next castle',
    help: 'The overlord designs it now.',
    fields: [],
  },
  {
    verb: 'start',
    group: 'Castle works',
    who: 'works',
    label: 'Start a castle design',
    help: '',
    fields: [{ name: 'design', label: 'Design', kind: 'select', source: 'designs' }],
  },
]

/** Words the cast parser reads as the start of another part: a place must not hold them. */
const CAST_STOPS = ['on', 'item', 'count', 'creature', 'effect', 'for']

const PATTERN: Record<FieldKind, RegExp> = {
  select: /^[A-Za-z0-9_./-]{1,80}$/,
  int: /^\d{1,5}$/,
  point: /^-?\d{1,8} -?\d{1,4} -?\d{1,8}$/,
  player: /^[A-Za-z0-9_]{1,20}$/,
  word: /^[a-z0-9_:]{1,40}$/,
  place: /^[A-Za-z0-9' -]{1,60}$/,
  text: /^[\x20-\x7e]{1,300}$/,
}

export interface CommandSpec {
  /** The bot it is for; for household and works commands, ignored. */
  bot?: string
  verb: string
  args?: Record<string, string | undefined>
}

export interface CourtBot {
  name: string
  division?: string
  magic?: boolean
}

/** Which command file a line goes to: the army's for its soldiers, the household's otherwise. */
export interface Built {
  line: string
  division: 'household' | 'army'
}

/** Control characters (a newline would start another command): never in a command. */
export function hasControl(text: string): boolean {
  return [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

function field(
  f: CommandField,
  raw: string | undefined,
  choices: Record<string, string[]>
): string | undefined {
  if (hasControl(raw ?? '')) throw new Error(`${f.label}: not a valid value`)
  const value = (raw ?? '').replace(/,/g, ' ').trim().replace(/ +/g, ' ')
  if (value === '') {
    if (f.optional) return undefined
    throw new Error(`${f.label}: needed`)
  }
  if (!PATTERN[f.kind].test(value)) throw new Error(`${f.label}: not a valid value`)
  const options = f.options ?? (f.source ? choices[f.source] : undefined)
  if (f.kind === 'select' && options && !options.includes(value))
    throw new Error(`${f.label}: one of ${options.join(', ')}`)
  if (f.kind === 'place' && value.split(' ').some((w) => CAST_STOPS.includes(w.toLowerCase())))
    throw new Error(`${f.label}: may not hold the words ${CAST_STOPS.join(', ')}`)
  return value
}

/** The command line for a form, checked. `choices` lists the world's spells and designs. */
export function buildCommand(
  spec: CommandSpec,
  bots: CourtBot[],
  choices: Record<string, string[]> = {}
): Built {
  const verb = VERBS.find((v) => v.verb === spec.verb)
  if (!verb) throw new Error(`no such command: ${spec.verb}`)
  const values: Record<string, string | undefined> = {}
  for (const f of verb.fields) values[f.name] = field(f, spec.args?.[f.name], choices)
  const forPart = values.for ? ['for', values.for] : []
  if (verb.who === 'household')
    return {
      line: ['household', verb.verb, values.at, ...forPart].join(' '),
      division: 'household',
    }
  if (verb.who === 'works') {
    const word = verb.verb === 'resume-works' ? 'resume' : verb.verb
    return { line: ['works', word, values.design].filter(Boolean).join(' '), division: 'household' }
  }
  const bot = bots.find((b) => b.name.toLowerCase() === (spec.bot ?? '').toLowerCase())
  if (!bot) throw new Error(`no such bot: ${spec.bot ?? '(none)'}`)
  if (verb.who === 'magic' && !bot.magic) throw new Error(`${bot.name} works no magic`)
  const words: Array<string | undefined> = [bot.name, verb.verb]
  switch (verb.verb) {
    case 'build':
      words.push(values.blueprint, values.at, ...forPart)
      break
    case 'resume':
      words.push(
        values.blueprint,
        values.at,
        ...(values.turns ? ['turns', values.turns] : []),
        ...forPart
      )
      break
    case 'commission':
      words.push(values.blueprint, ...(values.at ? ['at', values.at] : []), ...forPart)
      break
    case 'fetch':
      words.push(values.material, values.count, ...forPart)
      break
    case 'hall':
      words.push(values.work, ...forPart)
      break
    case 'hunt':
    case 'mine':
      words.push(values.count)
      break
    case 'undo':
      words.push(...forPart)
      break
    case 'cast':
      words.push(
        values.spell,
        ...(['on', 'to', 'item', 'count', 'creature', 'effect'] as const).flatMap((k) =>
          values[k] ? [k, values[k]] : []
        ),
        ...forPart
      )
      break
    case 'run':
      words.push(values.command)
      break
  }
  return {
    line: words.filter(Boolean).join(' '),
    division: bot.division === 'army' ? 'army' : 'household',
  }
}

/**
 * A line typed by hand, checked: one line of plain characters, for a bot of the court (or the
 * household or the works). Returns the command file it goes to.
 */
export function checkLine(line: string, bots: CourtBot[]): Built {
  const text = line.trim().replace(/ +/g, ' ')
  if (hasControl(text) || !/^[\x20-\x7e]{1,400}$/.test(text))
    throw new Error('one line of plain characters, at most 400')
  const first = text.split(' ')[0].toLowerCase()
  if (first === 'works' || first === 'household') return { line: text, division: 'household' }
  const bot = bots.find((b) => b.name.toLowerCase() === first)
  if (!bot)
    throw new Error(`a command starts with a bot’s name, works or household: not "${first}"`)
  return { line: text, division: bot.division === 'army' ? 'army' : 'household' }
}
