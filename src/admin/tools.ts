/**
 * The court's own scripts (scripts/), run from the admin inside a world's court container, where
 * they join that world's server as the player Surveyor (the court ignores it) or as the player
 * named. One at a time per world: two Surveyors would throw each other off the server.
 */
import { hasControl } from './commands'

export type ArgKind =
  'int' | 'design' | 'blueprint' | 'player' | 'line' | 'section' | 'bot' | 'statefile'

export interface ToolArg {
  name: string
  label: string
  kind: ArgKind
  optional?: boolean
  /** May be given more than once (lines to say, storeys to print). */
  many?: boolean
}

export interface Tool {
  id: string
  script: string
  label: string
  help: string
  args: ToolArg[]
  /** Said before it runs: what it does to the world. */
  warning?: string
  /** It draws a picture (render-castle): the admin names the file and shows it. */
  picture?: boolean
}

const N = (name: string, label: string, optional = false): ToolArg => ({
  name,
  label,
  kind: 'int',
  optional,
})

export const TOOLS: Tool[] = [
  {
    id: 'survey-terrain',
    script: 'survey-terrain.ts',
    label: 'Height map of an area',
    help: 'One character per column: height of the top block, water (~), lava (!), trees (T), made blocks (#).',
    args: [
      N('x1', 'x1'),
      N('z1', 'z1'),
      N('x2', 'x2'),
      N('z2', 'z2'),
      N('baseY', 'Base height', true),
    ],
  },
  {
    id: 'survey-layers',
    script: 'survey-layers.ts',
    label: 'A box of blocks, layer by layer',
    help: 'Holes, walls, roofs and caves, top down.',
    args: [
      N('x1', 'x1'),
      N('z1', 'z1'),
      N('x2', 'x2'),
      N('z2', 'z2'),
      N('y1', 'y1'),
      N('y2', 'y2'),
    ],
  },
  {
    id: 'survey-build',
    script: 'survey-build.ts',
    label: 'Check a blueprint where it stands',
    help: 'Missing or different blocks, and the ground under it.',
    args: [
      { name: 'blueprint', label: 'Blueprint', kind: 'blueprint' },
      N('x', 'x'),
      N('y', 'y'),
      N('z', 'z'),
      N('turns', 'Turns', true),
    ],
  },
  {
    id: 'check-section',
    script: 'check-section.ts',
    label: 'Check a castle’s sections',
    help: 'What is not as planned, and what stands there instead.',
    args: [
      { name: 'design', label: 'Design', kind: 'design' },
      { name: 'sections', label: 'Section id prefix', kind: 'section', optional: true, many: true },
    ],
  },
  {
    id: 'plan-castle',
    script: 'plan-castle.ts',
    label: 'Plan a castle design',
    help: 'Problems, sections and a map of each storey (no server needed).',
    args: [
      { name: 'design', label: 'Design', kind: 'design' },
      { name: 'storeys', label: 'Storey heights', kind: 'int', optional: true, many: true },
    ],
  },
  {
    id: 'render-castle',
    script: 'render-castle.ts',
    label: 'Picture of a castle design',
    help: 'Each storey from above, side by side (no server needed).',
    picture: true,
    args: [{ name: 'design', label: 'Design', kind: 'design' }, N('scale', 'Scale', true)],
  },
  {
    id: 'say-as',
    script: 'say-as.ts',
    label: 'Talk to the court as a player',
    help: 'Joins as that player, says each line, waits half a minute for answers after each, prints the chat.',
    warning:
      'Joins the world’s server as that player: never use the name of someone online, and the court takes a royal’s name for the royal.',
    args: [
      { name: 'player', label: 'Player', kind: 'player' },
      { name: 'lines', label: 'Line', kind: 'line', many: true },
    ],
  },
  {
    id: 'works-one',
    script: 'works-one.ts',
    label: 'Build one castle section',
    help: 'One bot builds a single section (creative).',
    warning:
      'The bot builds in the world. It joins under its own name: stop that bot’s court first, or the server throws one of the two off.',
    args: [
      { name: 'design', label: 'Design', kind: 'design' },
      { name: 'section', label: 'Section id', kind: 'section' },
      { name: 'bot', label: 'Bot', kind: 'bot', optional: true },
    ],
  },
  {
    id: 'overlord-plan',
    script: 'overlord-plan.ts',
    label: 'Let the overlord design a castle',
    help: 'From a terrain survey saved as json; writes the design it settles on. Uses the big model for minutes.',
    args: [
      { name: 'terrain', label: 'Terrain file (.state/…json)', kind: 'statefile' },
      { name: 'out', label: 'Design to write (.state/designs/…json)', kind: 'statefile' },
    ],
  },
  {
    id: 'ollama-check',
    script: 'ollama-check.ts',
    label: 'Check the model server',
    help: 'Lists the models and has one chat.',
    args: [],
  },
]

const PATTERN: Record<ArgKind, RegExp> = {
  int: /^-?\d{1,8}$/,
  design: /^(config\/castles|\.state\/designs)\/[\w.-]+\.json$/,
  blueprint: /^[a-z]{1,20}$/,
  player: /^[A-Za-z0-9_]{1,20}$/,
  line: /^[\x20-\x7e]{1,200}$/,
  section: /^[\w-]{1,80}$/,
  bot: /^[A-Za-z0-9_]{1,16}$/,
  statefile: /^\.state\/(?:[\w-]+\/)*[\w.-]+\.json$/,
}

/** The script's arguments, checked, in order. `choices` holds the world's designs and bots. */
export function toolArgs(
  tool: Tool,
  given: Record<string, string | string[] | undefined>,
  choices: { designs: string[]; bots: string[]; blueprints: string[] }
): string[] {
  const out: string[] = []
  const valuesOf = (name: string) => {
    const raw = given[name]
    return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map((v) => String(v).trim())
      .filter((v) => v !== '')
  }
  for (const arg of tool.args) {
    const values = valuesOf(arg.name)
    if (!arg.many && values.length > 1) throw new Error(`${arg.label}: one value`)
    if (!values.length && !arg.optional) throw new Error(`${arg.label}: needed`)
    for (const v of values) {
      if (hasControl(v) || !PATTERN[arg.kind].test(v) || v.includes('..'))
        throw new Error(`${arg.label}: not a valid value`)
      if (arg.kind === 'design' && !choices.designs.includes(v))
        throw new Error(`${arg.label}: no such design`)
      if (arg.kind === 'bot' && !choices.bots.includes(v))
        throw new Error(`${arg.label}: no such bot`)
      if (arg.kind === 'blueprint' && !choices.blueprints.includes(v))
        throw new Error(`${arg.label}: no such blueprint`)
      out.push(v)
    }
    // Arguments after an optional one that was left out would land in its place.
    if (
      !values.length &&
      tool.args.slice(tool.args.indexOf(arg) + 1).some((a) => valuesOf(a.name).length)
    )
      throw new Error(`${arg.label}: needed when the ones after it are given`)
  }
  return out
}
