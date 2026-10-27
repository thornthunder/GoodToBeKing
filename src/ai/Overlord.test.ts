import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CastleDesign } from '../build/design'
import { findCastleSites, type SiteOption } from '../build/sites'
import { courtProblems, Overlord, placeOnSite } from './Overlord'
import type { ChatMessage, ChatModel } from './OllamaClient'

const great = JSON.parse(
  fs.readFileSync('config/castles/great-castle.json', 'utf8')
) as CastleDesign
const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
} as never

/** The great castle without its gatehouse, with a gate of its own: a design the court accepts. */
function standalone(): CastleDesign {
  const d = structuredClone(great)
  delete d.existing
  d.name = 'the Summer Castle'
  d.gates = [{ side: 'south', at: 20, width: 3, height: 3 }]
  return d
}

const site: SiteOption = {
  area: { x: 200, z: 300, width: 36, depth: 30 },
  floorY: 70,
  cut: 10,
  fill: 20,
  trees: 0,
  water: 0,
  distance: 50,
  direction: 'east',
}

function fakeModel(replies: string[]): ChatModel & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  return {
    seen,
    async chat(messages) {
      seen.push(structuredClone(messages))
      return { message: { role: 'assistant', content: replies.shift() ?? '{}' } } as never
    },
  }
}

describe('the overlord', () => {
  it('a design without a gate or the royal rooms is sent back with reasons', () => {
    const d = structuredClone(great)
    delete d.existing
    d.buildings = d.buildings.filter((b) => b.name !== 'the Keep')
    const problems = courtProblems(d)
    expect(problems).toContain('the curtain wall needs a gate so people can come in')
    expect(problems.some((p) => p.includes('throne room'))).toBe(true)
    expect(problems.some((p) => p.includes("Princess's bedchamber"))).toBe(true)
  })

  it('notices a door that opens into another building', () => {
    const d = standalone()
    d.buildings[0].doors = [{ side: 'south', at: 3 }] // the kitchen's south wall backs onto the west range
    expect(courtProblems(d).some((p) => p.includes('opens straight into the west range'))).toBe(
      true
    )
  })

  it('places a design on its site, centred and never bigger', () => {
    const d = placeOnSite(standalone(), site)
    expect(d.area).toEqual({ x: 201, z: 301, width: 34, depth: 28 })
    expect(d.floorY).toBe(70)
  })

  it('reads rooms counted from their own building corner the way they were meant', () => {
    const d = standalone()
    const range = d.buildings[1] // the west range at x 0, z 11
    for (const s of range.storeys) for (const r of s.rooms) r.z -= range.z
    range.ladder = { x: 1, z: 10 }
    const fixed = placeOnSite(d, site)
    expect(fixed.buildings[1].storeys[0].rooms[0].z).toBe(11)
    expect(fixed.buildings[1].ladder).toEqual({ x: 1, z: 21 })
    expect(fixed.buildings[0]).toEqual(d.buildings[0])
  })

  it('keeps asking until the design is sound', async () => {
    const good = standalone()
    const bad = { ...good, gates: [] }
    const model = fakeModel([
      'not json at all',
      JSON.stringify({ site: 1, summary: 'A castle.', design: bad }),
      JSON.stringify({ site: 1, summary: 'A summer castle by the forest.', design: good }),
    ])
    const result = await new Overlord(model, 'big', silent).planCastle({
      sites: [site],
      crew: [{ name: 'Henry', role: 'apprentice' }],
    })
    expect(result?.rounds).toBe(3)
    expect(result?.design.name).toBe('the Summer Castle')
    expect(result?.summary).toContain('summer castle')
    const lastAsk = model.seen[2].at(-1)?.content ?? ''
    expect(lastAsk).toContain('needs a gate')
  })
})

describe('finding castle sites', () => {
  /** Flat sand at 64 with a hill in the west, a village path in the south and a pond in the north. */
  const world = (x: number, z: number) => {
    if (z > 160 && x > 100 && x < 110) return { y: 64, name: 'grass_path' }
    if (z < 40 && x > 120 && x < 140) return { y: 62, name: 'water' }
    return { y: x < 60 ? 64 + Math.floor((60 - x) / 2) : 64, name: 'sand' }
  }

  it('prefers flat open ground away from paths, water and what stands already', () => {
    const sites = findCastleSites(
      world,
      { center: { x: 100, y: 64, z: 100 }, radius: 90 },
      { avoid: [{ x: 90, z: 90, width: 30, depth: 30 }] }
    )
    expect(sites.length).toBe(3)
    for (const s of sites) {
      expect(s.cut + s.fill).toBe(0)
      expect(s.area.x).toBeGreaterThanOrEqual(60)
      // Not on top of the existing castle (plus its margin) and away from the path.
      const clear =
        s.area.x + s.area.width <= 86 ||
        s.area.x >= 124 ||
        s.area.z + s.area.depth <= 86 ||
        s.area.z >= 124
      expect(clear).toBe(true)
      expect(s.area.z + s.area.depth + 8).toBeLessThanOrEqual(161)
    }
  })
})
