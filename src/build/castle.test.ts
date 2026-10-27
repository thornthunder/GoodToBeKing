import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { compileDesign, MAX_SECTION_CELLS, type Plan } from './compile'
import { validateDesign, type CastleDesign } from './design'
import type { Job, JobResult } from './Mason'
import { Works, type Worker, type WorksEvent } from './Works'

const great = JSON.parse(fs.readFileSync('config/castles/great-castle.json', 'utf8')) as CastleDesign
const req = createRequire(require.resolve('mineflayer-bedrock/package.json'))
const mcData = req('minecraft-data')('bedrock_1.26.0') as { itemsByName: Record<string, unknown> }
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } } as never

describe('castle designs', () => {
  it('the great castle design is valid', () => {
    expect(validateDesign(great)).toEqual([])
  })

  it('explains what is wrong with a broken design', () => {
    const broken: CastleDesign = {
      ...great,
      buildings: [
        { ...great.buildings[0], x: 30, doors: [] },
        { ...great.buildings[1], storeys: [{ rooms: [{ name: 'x', type: 'ballroom' as never, x: 0, z: 11, width: 9, depth: 6 }] }] },
      ],
    }
    const problems = validateDesign(broken)
    expect(problems.some((p) => p.includes('inside the area'))).toBe(true)
    expect(problems.some((p) => p.includes('needs at least one door'))).toBe(true)
    expect(problems.some((p) => p.includes('unknown type "ballroom"'))).toBe(true)
  })
})

describe('compiling the great castle', () => {
  const plan = compileDesign(great)

  it('uses only blocks the game knows as items', () => {
    const names = new Set(plan.sections.flatMap((s) => s.cells.map((c) => c.block)))
    for (const s of plan.sections) for (const col of s.columns) names.add(col.material)
    names.delete('air')
    const unknown = [...names].filter((n) => !mcData.itemsByName[n])
    expect(unknown).toEqual([])
  })

  it('places every block exactly once, inside the castle or the repaired old castle', () => {
    const seen = new Set<string>()
    const { x, z, width, depth } = plan.area
    for (const s of plan.sections)
      for (const c of s.cells) {
        const k = `${c.x},${c.y},${c.z}`
        expect(seen.has(k)).toBe(false)
        seen.add(k)
        const inArea = c.x >= x && c.x < x + width && c.z >= z && c.z < z + depth
        expect(inArea || s.kind === 'repair').toBe(true)
      }
  })

  it('splits big sections and orders storeys', () => {
    for (const s of plan.sections) expect(s.cells.length + s.columns.length).toBeLessThan(MAX_SECTION_CELLS * 1.6)
    const ids = plan.sections.map((s) => s.id)
    for (const [i, s] of plan.sections.entries())
      for (const dep of s.after) expect(ids.indexOf(dep)).toBeLessThan(i)
  })

  it('gives the royal rooms their furniture', () => {
    const blocks = plan.sections.flatMap((s) => s.cells.map((c) => c.block))
    for (const b of ['bed', 'gold_block', 'amethyst_block', 'furnace', 'smoker', 'bookshelf', 'enchanting_table', 'ladder', 'red_carpet', 'magenta_carpet'])
      expect(blocks).toContain(b)
    // Beds come in pairs: a placed foot and an automatic head.
    const beds = plan.sections.flatMap((s) => s.cells.filter((c) => c.block === 'bed'))
    expect(beds.filter((c) => c.auto).length).toBe(beds.filter((c) => !c.auto).length)
    expect(beds.every((c) => c.auto || c.from)).toBe(true)
  })

  it('opens a back gate in the old castle and leaves its walls otherwise alone', () => {
    const repair = plan.sections.find((s) => s.kind === 'repair')!
    const removed = repair.cells.filter((c) => c.remove)
    expect(removed.map((c) => `${c.x},${c.z}`).sort()).toEqual(
      ['104,128', '104,128', '104,128', '105,128', '105,128', '105,128', '106,128', '106,128', '106,128'].sort()
    )
    expect(repair.columns.length).toBe(121 + 3)
  })
})

function fakeWorker(name: string, outcome: (job: Job) => Partial<JobResult> = () => ({})) {
  const jobs: string[] = []
  const worker: Worker & { jobs: string[]; busy: boolean } = {
    name,
    jobs,
    busy: false,
    available: () => !worker.busy,
    position: () => ({ x: 100, y: 74, z: 110 }),
    async work(job) {
      worker.busy = true
      jobs.push(job.id)
      await Promise.resolve()
      worker.busy = false
      return { placed: job.cells.length, dug: 0, missing: 0, blocked: 0, cancelled: false, ...outcome(job) }
    },
  }
  return worker
}

async function runAll(plan: Plan, works: Works, workers: Worker[], rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !works.finished; i++) {
    works.tick(workers)
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('the works', () => {
  const plan = compileDesign(great)

  it('hands out every section, upper storeys only after the ones below', async () => {
    const events: WorksEvent[] = []
    const works = new Works(plan, undefined, silent, (e) => events.push(e))
    const a = fakeWorker('Henry')
    const b = fakeWorker('George')
    await runAll(plan, works, [a, b])
    expect(works.finished).toBe(true)
    const order = events.filter((e) => e.kind === 'assign').map((e) => (e as { section: { id: string } }).section.id)
    expect(new Set(order).size).toBe(plan.sections.length)
    expect(order.indexOf('b-keep-s2-p1')).toBeGreaterThan(order.indexOf('b-keep-s1-p3'))
    expect(events[0].kind).toBe('begin')
    expect(events.at(-1)?.kind).toBe('finished')
    expect(a.jobs.length).toBeGreaterThan(0)
    expect(b.jobs.length).toBeGreaterThan(0)
  })

  it('retries an incomplete section, then moves on', async () => {
    const works = new Works(plan, undefined, silent)
    const stubborn = plan.sections[0].id
    const w = fakeWorker('Bruce', (job) => (job.id === stubborn ? { missing: 50 } : {}))
    await runAll(plan, works, [w])
    expect(w.jobs.filter((id) => id === stubborn).length).toBe(3)
    expect(works.finished).toBe(true)
  })

  it('puts a cancelled section back for someone else', async () => {
    const works = new Works(plan, undefined, silent)
    let first = true
    const w = fakeWorker('Dyke', () => {
      if (!first) return {}
      first = false
      return { cancelled: true, missing: 10 }
    })
    await runAll(plan, works, [w])
    expect(w.jobs[0]).toBe(w.jobs[1])
    expect(works.finished).toBe(true)
  })
})
