/**
 * Draws a castle design as seen from above, one picture per storey side by side: walls, floors,
 * furniture and the courtyard in rough block colours. For looking at a plan outside the game.
 *
 *   tsx scripts/render-castle.ts <design.json> <out.png> [scale]
 */
import fs from 'node:fs'
import { PNG } from 'pngjs'
import { compileDesign, type PlanCell } from '../src/build/compile'
import { DEFAULT_STOREY_HEIGHT, type CastleDesign } from '../src/build/design'

const [file, out, scaleArg] = process.argv.slice(2)
const scale = Number(scaleArg ?? 8)
const design = JSON.parse(fs.readFileSync(file, 'utf8')) as CastleDesign
const plan = compileDesign(design)
const h = design.storeyHeight ?? DEFAULT_STOREY_HEIGHT
const storeys = Math.max(1, ...design.buildings.map((b) => b.storeys.length))

const COLOURS: Array<[RegExp, string]> = [
  [/^ladder$/, '#a0522d'],
  [/glass/, '#9fd8ff'],
  [/^bed$/, '#d33a5a'],
  [/magenta|amethyst|purple/, '#b04fc9'],
  [/red_carpet/, '#b3202a'],
  [/carpet/, '#d8c690'],
  [/gold/, '#f2c230'],
  [/quartz/, '#ece7dd'],
  [/lantern|torch|campfire|candle/, '#ffcc33'],
  [/bookshelf|lectern/, '#7a4e2a'],
  [/furnace|smoker|brick|anvil|grindstone|smithing|blast/, '#555555'],
  [/chest|barrel|crafting|loom|cartography|fletching|stonecutter|composter/, '#9c6b3a'],
  [/_slab$/, '#c49a5a'],
  [/hay|pumpkin|melon/, '#d9a520'],
  [/grass_block/, '#5fa64a'],
  [/allium|cornflower|daisy|tulip|bluet|lily/, '#e86fb0'],
  [/cauldron|iron_bars/, '#3a3a3a'],
  [/spruce_planks|oak_planks/, '#8a6a43'],
  [/polished_andesite/, '#a3a6a3'],
  [/stone_bricks|cobblestone|stone_brick_wall/, '#6f6f6f'],
]
const colour = (block: string): [number, number, number] => {
  const hex = COLOURS.find(([re]) => re.test(block))?.[1] ?? '#999999'
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

const byColumn = new Map<string, PlanCell[]>()
for (const s of plan.sections)
  for (const c of s.cells) {
    if (c.block === 'air') continue
    const k = `${c.x},${c.z}`
    if (!byColumn.has(k)) byColumn.set(k, [])
    byColumn.get(k)!.push(c)
  }

const { x: ax, z: az, width: W, depth: D } = plan.area
const gap = 4
const png = new PNG({ width: (storeys * (W + gap) - gap + 2) * scale, height: (D + 2) * scale })
png.data.fill(255)
const put = (px: number, pz: number, rgb: [number, number, number]) => {
  for (let j = 0; j < scale; j++)
    for (let i = 0; i < scale; i++) {
      const idx = ((pz * scale + j) * png.width + px * scale + i) * 4
      png.data[idx] = rgb[0]
      png.data[idx + 1] = rgb[1]
      png.data[idx + 2] = rgb[2]
      png.data[idx + 3] = 255
    }
}
for (let k = 0; k < storeys; k++) {
  // What stands in each column within this storey, seen from just under its ceiling.
  const lo = plan.floorY + k * h
  const hi = lo + h - 1
  for (let x = 0; x < W; x++)
    for (let z = 0; z < D; z++) {
      const cells = (byColumn.get(`${ax + x},${az + z}`) ?? []).filter(
        (c) => c.y >= lo && c.y <= hi - 1
      )
      if (!cells.length) continue
      const top = cells.sort((a, b) => b.y - a.y)[0]
      put(1 + k * (W + gap) + x, 1 + z, colour(top.block))
    }
}
fs.writeFileSync(out, PNG.sync.write(png))
console.log(`${plan.title}: ${storeys} storeys drawn to ${out}`)
