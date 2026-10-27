import { DEFAULT_PALETTE, type BlueprintId, type Palette } from './blueprints'

/** Colour words players use, mapped to a solid block and a flower of that colour. */
const COLOURS: Array<[RegExp, { solid: string; flower: string }]> = [
  [/\bmagenta\b/i, { solid: 'magenta_concrete', flower: 'allium' }],
  [/\bperi\s?winkle|perry\s?winkle\b/i, { solid: 'light_blue_concrete', flower: 'blue_orchid' }],
  [/\bpurple|violet|lilac\b/i, { solid: 'purple_concrete', flower: 'allium' }],
  [/\bpink\b/i, { solid: 'pink_concrete', flower: 'pink_tulip' }],
  [/\blight blue|sky blue\b/i, { solid: 'light_blue_concrete', flower: 'blue_orchid' }],
  [/\bblue\b/i, { solid: 'blue_concrete', flower: 'cornflower' }],
  [/\bred\b/i, { solid: 'red_concrete', flower: 'poppy' }],
  [/\byellow|golden|gold\b/i, { solid: 'yellow_concrete', flower: 'dandelion' }],
  [/\borange\b/i, { solid: 'orange_concrete', flower: 'orange_tulip' }],
  [/\bgreen\b/i, { solid: 'lime_concrete', flower: 'fern' }],
  [/\bwhite\b/i, { solid: 'white_concrete', flower: 'oxeye_daisy' }],
  [/\bblack\b/i, { solid: 'black_concrete', flower: 'wither_rose' }],
]

/** Colours named in a text, in the order they first appear. */
export function coloursIn(text: string): Array<{ solid: string; flower: string }> {
  const found: Array<{ at: number; colour: { solid: string; flower: string } }> = []
  for (const [pattern, colour] of COLOURS) {
    const m = pattern.exec(text)
    if (m && !found.some((f) => f.colour.solid === colour.solid))
      found.push({ at: m.index, colour })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.colour)
}

/**
 * The palette for a build: colours named in the request win, then colours the court remembers
 * the person loving, then the blueprint's own look. The wither rose stays out of gardens.
 */
export function choosePalette(id: BlueprintId, request: string, remembered: string[]): Palette {
  const colours = coloursIn(request).length ? coloursIn(request) : coloursIn(remembered.join(' '))
  const flowerColours = colours.filter((c) => c.flower !== 'wither_rose')
  if (colours.length === 0) return DEFAULT_PALETTE
  const [first, second] = colours
  return {
    primary: id === 'arch' ? (second ?? first).solid : first.solid,
    accent: id === 'arch' ? first.solid : (second?.solid ?? 'white_concrete'),
    light: DEFAULT_PALETTE.light,
    flowers: flowerColours.length
      ? [flowerColours[0].flower, (flowerColours[1] ?? flowerColours[0]).flower]
      : DEFAULT_PALETTE.flowers,
  }
}
