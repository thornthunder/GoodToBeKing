/**
 * Merlin's spellbook: small builds he can raise next to a player. A blueprint is a list of cells
 * relative to its bottom corner (x across, y up, z depth); its front (doorways) is the z = 0 side.
 */

export interface Palette {
  /** Walls and pillars. */
  primary: string
  /** Caps, lintels and trim. */
  accent: string
  /** Something that glows. */
  light: string
  /** Flowers, alternating. */
  flowers: [string, string]
}

export interface Cell {
  x: number
  y: number
  z: number
  block: string
}

export interface Blueprint {
  id: BlueprintId
  /** How the bot names it in chat, e.g. "a little tower". */
  title: string
  size: { x: number; y: number; z: number }
  cells: Cell[]
  /** The bottom layer needs grass or dirt under it (flowers). */
  needsSoil?: boolean
}

export type BlueprintId = 'tower' | 'arch' | 'garden' | 'castle'

export const DEFAULT_PALETTE: Palette = {
  primary: 'stone_bricks',
  accent: 'quartz_block',
  light: 'lantern',
  flowers: ['allium', 'cornflower'],
}

/** A 3x3 hollow tower, five blocks high, with a doorway, a cap, battlements and a lantern. */
function tower(p: Palette): Blueprint {
  const cells: Cell[] = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      for (let z = 0; z < 3; z++) {
        if (x === 1 && z === 1) continue // hollow inside
        if (x === 1 && z === 0 && y < 2) continue // doorway in the front
        cells.push({ x, y, z, block: p.primary })
      }
    }
  }
  for (let x = 0; x < 3; x++)
    for (let z = 0; z < 3; z++) cells.push({ x, y: 5, z, block: p.accent })
  for (const [x, z] of [
    [0, 0],
    [2, 0],
    [0, 2],
    [2, 2],
  ])
    cells.push({ x, y: 6, z, block: p.primary })
  cells.push({ x: 1, y: 6, z: 1, block: p.light })
  cells.push({ x: 1, y: 0, z: 1, block: p.light }) // a lantern on the floor inside
  return { id: 'tower', title: 'a little tower', size: { x: 3, y: 7, z: 3 }, cells }
}

/** Two pillars with a lintel across, five wide, and a light on top. */
function arch(p: Palette): Blueprint {
  const cells: Cell[] = []
  for (let y = 0; y < 4; y++) {
    cells.push({ x: 0, y, z: 0, block: p.primary })
    cells.push({ x: 4, y, z: 0, block: p.primary })
  }
  for (let x = 0; x < 5; x++) cells.push({ x, y: 4, z: 0, block: p.accent })
  cells.push({ x: 2, y: 5, z: 0, block: p.light })
  return { id: 'arch', title: 'a magic arch', size: { x: 5, y: 6, z: 1 }, cells }
}

/** A 5x5 ring of flowers in two colours with a lantern in the middle. */
function garden(p: Palette): Blueprint {
  const cells: Cell[] = []
  let i = 0
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const edge = x === 0 || x === 4 || z === 0 || z === 4
      if (edge) cells.push({ x, y: 0, z, block: p.flowers[i++ % 2] })
    }
  }
  cells.push({ x: 2, y: 0, z: 2, block: p.light })
  return {
    id: 'garden',
    title: 'a flower garden',
    size: { x: 5, y: 1, z: 5 },
    cells,
    needsSoil: true,
  }
}

/**
 * A simple castle, 11 x 11: four hollow corner towers (capped, with battlements and a lantern),
 * walls with crenellations between them, and a gate in the front wall with a lantern above it.
 * The courtyard inside is left as it is.
 */
function castle(p: Palette): Blueprint {
  const cells: Cell[] = []
  const add = (x: number, y: number, z: number, block: string) => cells.push({ x, y, z, block })
  const corners = [
    [0, 0],
    [8, 0],
    [0, 8],
    [8, 8],
  ]
  for (const [tx, tz] of corners) {
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        for (let z = 0; z < 3; z++) if (!(x === 1 && z === 1)) add(tx + x, y, tz + z, p.primary)
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) add(tx + x, 5, tz + z, p.accent)
    for (const [x, z] of [
      [0, 0],
      [2, 0],
      [0, 2],
      [2, 2],
    ])
      add(tx + x, 6, tz + z, p.primary)
    add(tx + 1, 6, tz + 1, p.light)
  }
  // Walls between the towers: front (z = 0) with a gate, back (z = 10), left (x = 0), right (x = 10).
  for (let i = 3; i <= 7; i++) {
    for (let y = 0; y < 4; y++) {
      const gate = i >= 4 && i <= 6 && y < 3
      if (!gate) add(i, y, 0, p.primary)
      add(i, y, 10, p.primary)
      add(0, y, i, p.primary)
      add(10, y, i, p.primary)
    }
  }
  for (const i of [3, 5, 7]) {
    add(i, 4, 0, p.accent)
    add(i, 4, 10, p.accent)
    add(0, 4, i, p.accent)
    add(10, 4, i, p.accent)
  }
  add(5, 5, 0, p.light) // a lantern over the gate
  return { id: 'castle', title: 'a simple castle', size: { x: 11, y: 7, z: 11 }, cells }
}

const MAKERS: Record<BlueprintId, (p: Palette) => Blueprint> = { tower, arch, garden, castle }

/** The words that pick each build. */
const KEYWORDS: Array<[BlueprintId, RegExp]> = [
  ['castle', /\b(castle|fortress|palace)\b/i],
  ['tower', /\b(tower|turret|keep|lighthouse)\b/i],
  ['arch', /\b(arch|archway|gate|gateway|portal)\b/i],
  ['garden', /\b(garden|flowers?|flowerbed|meadow)\b/i],
]

export const BLUEPRINT_IDS = Object.keys(MAKERS) as BlueprintId[]

export function makeBlueprint(id: BlueprintId, palette: Palette = DEFAULT_PALETTE): Blueprint {
  return MAKERS[id](palette)
}

/** Which build a request names, if any. */
export function matchBlueprint(text: string): BlueprintId | null {
  for (const [id, pattern] of KEYWORDS) if (pattern.test(text)) return id
  return null
}

/** "a little tower, a magic arch or a flower garden" */
export function spellbookList(): string {
  const titles = BLUEPRINT_IDS.map((id) => makeBlueprint(id).title)
  return `${titles.slice(0, -1).join(', ')} or ${titles.at(-1)}`
}

/**
 * Turn a blueprint a number of quarter turns around its footprint, keeping the bottom corner at
 * (0, 0, 0). One turn moves the front (z = 0) to face +x... see the tests for all four.
 */
export function rotate(bp: Blueprint, quarterTurns: number): Blueprint {
  const turns = ((quarterTurns % 4) + 4) % 4
  let cells = bp.cells
  let { x: sx, z: sz } = bp.size
  for (let t = 0; t < turns; t++) {
    // (x, z) -> (sz - 1 - z, x): a clockwise quarter turn seen from above.
    cells = cells.map((c) => ({ ...c, x: sz - 1 - c.z, z: c.x }))
    ;[sx, sz] = [sz, sx]
  }
  return { ...bp, cells, size: { x: sx, y: bp.size.y, z: sz } }
}
