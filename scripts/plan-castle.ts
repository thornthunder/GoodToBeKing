/**
 * Compiles a castle design and prints it: problems, sections and a map of each storey.
 *
 *   tsx scripts/plan-castle.ts config/castles/great-castle.json [y ...]
 */
import fs from 'node:fs'
import { compileDesign } from '../src/build/compile'
import { validateDesign, type CastleDesign } from '../src/build/design'

const file = process.argv[2] ?? 'config/castles/great-castle.json'
const design = JSON.parse(fs.readFileSync(file, 'utf8')) as CastleDesign
const problems = validateDesign(design)
if (problems.length) {
  console.log('problems:\n  ' + problems.join('\n  '))
  process.exit(1)
}
const plan = compileDesign(design)
let total = 0
for (const s of plan.sections) {
  total += s.cells.length
  console.log(
    `${s.id.padEnd(34)} ${String(s.cells.length).padStart(4)} cells ${String(s.columns.length).padStart(4)} cols  after [${s.after.join(', ')}]  ${s.title}`
  )
}
console.log(`${plan.sections.length} sections, ${total} cells, top y=${plan.top}`)
const SYMBOL: Array<[RegExp, string]> = [
  [/^ladder$/, 'H'], [/glass/, 'o'], [/^bed$/, 'b'], [/carpet/, '-'], [/_slab$/, '='], [/lantern/, '*'],
  [/^(stone_bricks|cobblestone|chiseled_stone_bricks)$/, '#'], [/spruce_planks/, '+'], [/polished_andesite/, '.'],
  [/air/, ' '], [/bookshelf/, 'B'], [/furnace|smoker|campfire|brick/, 'F'], [/chest|barrel/, 'c'], [/quartz/, 'q'],
  [/gold|amethyst/, 'T'], [/grass|allium|cornflower|daisy|tulip|bluet|lily/, '"'],
]
const ys = process.argv.slice(3).map(Number)
const cells = new Map<string, string>()
for (const s of plan.sections) for (const c of s.cells) cells.set(`${c.x},${c.y},${c.z}`, c.block)
for (const y of ys.length ? ys : [plan.floorY, plan.floorY + 1, plan.floorY + 2]) {
  console.log(`\ny=${y}`)
  for (let z = plan.area.z - 1; z <= plan.area.z + plan.area.depth + 1; z++) {
    let row = ''
    for (let x = plan.area.x; x < plan.area.x + plan.area.width; x++) {
      const b = cells.get(`${x},${y},${z}`)
      row += b === undefined ? ' ' : (SYMBOL.find(([re]) => re.test(b))?.[1] ?? '?')
    }
    console.log(`${String(z).padStart(4)} ${row}`)
  }
}
