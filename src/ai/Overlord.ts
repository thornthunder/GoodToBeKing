/**
 * The overlord: a larger model that plans the court's next castle on its own. It is given the
 * design language, the candidate building sites the court surveyed, and who is in the crew;
 * it answers with a castle design (JSON), which is checked and sent back with every problem
 * explained until it is sound. The design is then compiled and built by the Works like any other.
 */
import { compileDesign } from '../build/compile'
import {
  FEATURE_TYPES,
  ROOM_TYPES,
  validateDesign,
  type BuildingDesign,
  type CastleDesign,
  type Rect,
} from '../build/design'
import type { SiteOption } from '../build/sites'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import type { OllamaConfig } from '../config'
import { OllamaClient, type ChatMessage, type ChatModel } from './OllamaClient'

export interface CrewMember {
  name: string
  role: string
}

export interface Brief {
  sites: SiteOption[]
  crew: CrewMember[]
  /** A finished design to learn the language from (not to copy). */
  example?: CastleDesign
  /** Names already used, so the new castle gets its own. */
  takenNames?: string[]
  /** What is asked, when a royal ordered it ("The King orders a new palace ..."). */
  request?: string
  /** What the sites' directions are measured from (default: the old castle grounds). */
  around?: string
}

export interface OverlordResult {
  design: CastleDesign
  site: SiteOption
  rounds: number
  /** The overlord's own words about the plan, for the Castellan to announce. */
  summary: string
}

const MAX_ROUNDS = 10

/** Room types the court needs in every castle, with the reason given back to the overlord. */
const NEEDED: Array<[string[], string]> = [
  [['kitchen'], 'a kitchen'],
  [['great_hall', 'dining_hall'], 'a great hall to feast in'],
  [['throne_room'], 'a throne room'],
  [['royal_bedchamber'], "the King's bedchamber (royal_bedchamber)"],
  [['princess_bedchamber'], "the Princess's bedchamber (princess_bedchamber)"],
  [
    ['barracks', 'guardroom'],
    'quarters for the royal guards Bruce and Dyke (barracks or guardroom)',
  ],
  [['bedchamber'], "the Castellan Festaris's chamber (bedchamber)"],
  [['apprentices_chamber'], 'a chamber for the apprentices Henry and George (apprentices_chamber)'],
  [['wizard_study'], "Merlin's study (wizard_study)"],
  [['pantry', 'storeroom'], 'a pantry or storeroom'],
]

export const DESIGN_GUIDE = `You are the master builder of a royal court on a family Minecraft server. You design castles in a small JSON language; the court's builders then raise every block for you.

THE LANGUAGE
A design is one JSON object:
{
  "name": "the Summer Castle",            // the castle's name, starting with "the"
  "area": { "width": W, "depth": D },      // the castle's footprint in blocks; x runs west to east (0..W-1), z runs north to south (0..D-1)
  "wallHeight": 6,                         // curtain wall height, 5 to 7
  "gates": [ { "side": "south", "at": 14, "width": 3, "height": 3 } ],   // openings in the curtain wall (the way in)
  "towers": [ { "name": "the north-west tower", "x": 0, "z": 0, "size": 5, "height": 10, "doors": [ { "side": "east", "at": 2 } ] } ],
  "buildings": [ BUILDING, ... ],
  "features": [ { "type": "garden", "x": 12, "z": 20, "width": 3, "depth": 3 }, { "type": "well", "x": 18, "z": 20 }, { "type": "lamp", "x": 10, "z": 15 } ]
}
A curtain wall runs all around the edge of the area automatically; buildings and towers on the edge replace it there.
BUILDING:
{
  "name": "the Keep", "x": 0, "z": 0, "width": 20, "depth": 12,    // its rectangle, walls included
  "doors": [ { "side": "south", "at": 9, "width": 2, "height": 3 } ],   // ground-storey doors in its outer walls
  "ladder": { "x": 12, "z": 10 },          // needed with 2 or more storeys: a column inside, right against an outer wall
  "crew": ["Henry", "George"],             // optional: who should build it
  "storeys": [ { "rooms": [ ROOM, ... ] }, ... ]   // bottom storey first, 1 to 4 storeys, each 5 blocks high
}
ROOM: { "name": "kitchen", "type": "kitchen", "x": 0, "z": 0, "width": 8, "depth": 12, "honour": "north" }
- A room's rectangle includes its walls. Rooms of one storey sit side by side and SHARE the wall line where they meet: a room from x 0 width 8 ends at x 7, so the next room starts at x 7.
- Doorways between rooms that share a wall are made automatically. Upper storeys are reached by the building's ladder.
- "honour" (optional) is the wall for the seat of honour: the throne, the altar, the high table or the bed.
- Room types and what the builders put in them: ${ROOM_TYPES.join(', ')}.
- Feature types: ${FEATURE_TYPES.join(', ')} (gardens are flower beds; features must stand in the open courtyard).

THE RULES
- All x and z are counted from the area's north-west corner, 0-based. Everything must lie inside the area.
- Buildings and towers may share a wall line with each other but must not overlap beyond that.
- Every building needs at least one door, and every door and gate must open into the open courtyard, not into another building or tower.
- A door's "at" counts along its wall from the west end (north and south walls) or the north end (east and west walls), and must stay at least one block away from the corners.
- Rooms must be at least 4 by 4, walls included; buildings at least 5 by 5; towers between 3 and 9 square.
- Leave an open courtyard of at least 8 by 8 inside the walls, reachable from the gate, so people can walk from the gate to every door.
- The rooms of each storey should fill their building (share walls rather than leave empty space). A great hall or throne room needs at least 7 blocks on its short side; stables stand on the ground storey.
- Think like a real castle builder: the kitchen next to the hall, the royal bedchambers high up in the keep, the guards near the gate, the stables by the wall.

Answer with JSON only: { "site": <number of the site you choose>, "summary": "<one or two sentences about your plan, for the Castellan to announce>", "design": { ...the design... } }`

function siteLine(s: SiteOption, i: number, around = 'the old castle grounds'): string {
  return (
    `Site ${i + 1}: ${s.area.width} by ${s.area.depth} blocks, ${s.direction} of ${around} ` +
    `(${s.distance} blocks away). Earth to move: ${s.cut} blocks to dig and ${s.fill} to fill; ` +
    `${s.trees} columns of trees; ${s.water} of water.`
  )
}

/** What the court needs, as one message for the overlord. */
export function briefText(brief: Brief): string {
  const sites = brief.sites.map((s, i) => siteLine(s, i, brief.around)).join('\n')
  const crew = brief.crew.map((c) => `${c.name} (${c.role})`).join(', ')
  return [
    brief.request ?? 'The court asks you for a second castle, different from the first.',
    `The builders: ${crew}.`,
    'It must have rooms for the royal family (the King and the Princess, who is seven) and for the staff: ' +
      NEEDED.map(([, why]) => why).join(', ') +
      '. Add whatever else a fine castle has: a chapel, a library, an armoury, stables, towers, gardens.',
    'Choose one of these sites (all are open ground; your area may be smaller than the site but not bigger):',
    sites,
    brief.takenNames?.length ? `Names already taken: ${brief.takenNames.join(', ')}.` : '',
    brief.example
      ? `Here is the first castle, so you can see the language in use (do not copy it; your castle stands on its own, with its own gate since it has no gatehouse):\n${JSON.stringify(stripExample(brief.example))}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function stripExample(d: CastleDesign): unknown {
  const { area, floorY: _y, existing: _e, ...rest } = d
  void _y
  void _e
  return { ...rest, area: { width: area.width, depth: area.depth } }
}

/** Problems beyond the language rules: what the court needs, and doors that open into walls. */
export function courtProblems(d: CastleDesign): string[] {
  const problems: string[] = []
  const types = new Set(
    d.buildings.flatMap((b) => b.storeys.flatMap((s) => s.rooms.map((r) => r.type)))
  )
  for (const [options, why] of NEEDED)
    if (!options.some((t) => types.has(t as never))) problems.push(`the castle still needs ${why}`)
  if (!d.gates?.length) problems.push('the curtain wall needs a gate so people can come in')
  const solids: Array<{ name: string; rect: Rect }> = [
    ...(d.towers ?? []).map((t) => ({
      name: t.name,
      rect: { x: t.x, z: t.z, width: t.size, depth: t.size },
    })),
    ...d.buildings.map((b) => ({ name: b.name, rect: b as Rect })),
  ]
  const blockedBy = (x: number, z: number, self: string) =>
    solids.find(
      (s) =>
        s.name !== self &&
        x >= s.rect.x &&
        x < s.rect.x + s.rect.width &&
        z >= s.rect.z &&
        z < s.rect.z + s.rect.depth
    )
  const outside = (x: number, z: number) => x < 0 || z < 0 || x >= d.area.width || z >= d.area.depth
  const step = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const
  const doorCell = (r: Rect, side: keyof typeof step, at: number): [number, number] =>
    side === 'north'
      ? [r.x + at, r.z]
      : side === 'south'
        ? [r.x + at, r.z + r.depth - 1]
        : side === 'west'
          ? [r.x, r.z + at]
          : [r.x + r.width - 1, r.z + at]
  // Every door cell of every building and tower: a door may open onto another's door.
  const doorCells = new Set<string>()
  const allDoors: Array<{ rect: Rect; doors: BuildingDesign['doors'] }> = [
    ...d.buildings.map((b) => ({ rect: b as Rect, doors: b.doors })),
    ...(d.towers ?? []).map((t) => ({
      rect: { x: t.x, z: t.z, width: t.size, depth: t.size },
      doors: t.doors,
    })),
  ]
  for (const { rect, doors } of allDoors)
    for (const o of doors ?? [])
      for (let i = 0; i < (o.width ?? 1); i++) {
        const [x, z] = doorCell(rect, o.side, o.at + i)
        doorCells.add(`${x},${z}`)
      }
  const checkDoors = (name: string, r: Rect, doors: BuildingDesign['doors'], kind: string) => {
    for (const o of doors ?? []) {
      const [x, z] = doorCell(r, o.side, o.at)
      const [dx, dz] = step[o.side] ?? [0, 0]
      const ox = x + dx
      const oz = z + dz
      if (outside(ox, oz)) {
        if (kind !== 'gate')
          problems.push(
            `the ${o.side} door of ${name} opens outside the castle walls; put it on a side facing the courtyard`
          )
        continue
      }
      const other = blockedBy(ox, oz, name)
      if (other && !doorCells.has(`${ox},${oz}`))
        problems.push(
          `the ${o.side} ${kind} of ${name} at ${o.at} opens straight into ${other.name} (give ${other.name} a door right there, or move this one)`
        )
    }
  }
  // A builder's review: rooms that fill their storeys, halls big enough to feast in, horses below.
  for (const b of d.buildings) {
    const interior = Math.max(1, (b.width - 2) * (b.depth - 2))
    for (const [k, storey] of b.storeys.entries()) {
      const covered = new Set<string>()
      for (const r of storey.rooms)
        for (let x = r.x + 1; x < r.x + r.width - 1; x++)
          for (let z = r.z + 1; z < r.z + r.depth - 1; z++) covered.add(`${x},${z}`)
      if (covered.size < interior * 0.75)
        problems.push(
          `storey ${k + 1} of ${b.name} leaves much of the building empty: let its rooms fill the whole building, sharing walls`
        )
      for (const r of storey.rooms) {
        const big = r.type === 'great_hall' || r.type === 'throne_room' || r.type === 'dining_hall'
        if (big && (Math.min(r.width, r.depth) < 7 || r.width * r.depth < 80))
          problems.push(
            `the ${r.name} in ${b.name} is too small for its purpose: make it at least 7 blocks on its short side and about 80 blocks in area`
          )
        if (r.type === 'stables' && k > 0)
          problems.push(
            `the ${r.name} in ${b.name} must be on the ground storey: horses cannot climb ladders`
          )
      }
    }
  }
  for (const b of d.buildings) checkDoors(b.name, b, b.doors, 'door')
  for (const t of d.towers ?? [])
    checkDoors(t.name, { x: t.x, z: t.z, width: t.size, depth: t.size }, t.doors, 'door')
  const area = { x: 0, z: 0, width: d.area.width, depth: d.area.depth }
  for (const g of d.gates ?? []) {
    const r = area
    const [x, z] =
      g.side === 'north'
        ? [g.at, 0]
        : g.side === 'south'
          ? [g.at, r.depth - 1]
          : g.side === 'west'
            ? [0, g.at]
            : [r.width - 1, g.at]
    const [dx, dz] = step[g.side] ?? [0, 0]
    const inner = blockedBy(x - dx, z - dz, '')
    if (inner)
      problems.push(
        `the ${g.side} gate at ${g.at} opens into ${inner.name}; move it to where the courtyard meets the wall`
      )
  }
  return problems
}

/**
 * A common slip: rooms and ladders counted from their building's own corner instead of the
 * castle's. When everything of a building only fits that way, read it that way.
 */
export function normaliseRooms(d: CastleDesign): CastleDesign {
  const within = (r: Rect, b: Rect) =>
    r.x >= b.x && r.z >= b.z && r.x + r.width <= b.x + b.width && r.z + r.depth <= b.z + b.depth
  const buildings = (d.buildings ?? []).map((b) => {
    const rooms = (b.storeys ?? []).flatMap((s) => s.rooms ?? [])
    if (!rooms.length || rooms.every((r) => within(r, b))) return b
    const shifted = (r: Rect) => ({ ...r, x: r.x + b.x, z: r.z + b.z })
    if (!rooms.every((r) => within(shifted(r), b))) return b
    const ladder = b.ladder
    const inner = (l: { x: number; z: number }) =>
      l.x > b.x && l.x < b.x + b.width - 1 && l.z > b.z && l.z < b.z + b.depth - 1
    return {
      ...b,
      storeys: b.storeys.map((s) => ({
        ...s,
        rooms: s.rooms.map((r) => ({ ...r, x: r.x + b.x, z: r.z + b.z })),
      })),
      ...(ladder && !inner(ladder) && inner({ x: ladder.x + b.x, z: ladder.z + b.z })
        ? { ladder: { x: ladder.x + b.x, z: ladder.z + b.z } }
        : {}),
    }
  })
  return { ...d, buildings }
}

/** Put a design on a chosen site: world corner, floor height, and an area no bigger than the site. */
export function placeOnSite(raw: CastleDesign, site: SiteOption): CastleDesign {
  const width = Math.min(raw.area?.width ?? site.area.width, site.area.width)
  const depth = Math.min(raw.area?.depth ?? site.area.depth, site.area.depth)
  return {
    ...normaliseRooms(raw),
    floorY: site.floorY,
    area: {
      x: site.area.x + Math.floor((site.area.width - width) / 2),
      z: site.area.z + Math.floor((site.area.depth - depth) / 2),
      width,
      depth,
    },
    existing: undefined,
    keepOut: undefined,
  }
}

/**
 * A client for the overlord's model, which the court's memory and another program on the same
 * server use too: the overlord asks for it as shared (ChatOptions.shared), so it is used as it is
 * loaded. Asking for another context would load it again, partly on the CPU (gemma4:31b at 5
 * instead of 32 tokens/s), and push the others' copy out. Its rounds take minutes.
 */
export function overlordClient(cfg: OllamaConfig, model: string, log: Logger): OllamaClient {
  return new OllamaClient({ ...cfg, model, timeoutMs: 60 * 60_000 }, log)
}

export class Overlord {
  constructor(
    private readonly ai: ChatModel,
    private readonly model: string,
    private readonly log: Logger
  ) {}

  async planCastle(brief: Brief): Promise<OverlordResult | null> {
    if (!brief.sites.length) {
      this.log.warn('no building sites to choose from')
      return null
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: DESIGN_GUIDE },
      { role: 'user', content: briefText(brief) },
    ]
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const started = Date.now()
      let content: string
      try {
        const response = await this.ai.chat(messages, {
          model: this.model,
          format: 'json',
          think: true,
          temperature: 0.5,
          stream: true,
          shared: true,
        })
        content = response.message.content
      } catch (err) {
        this.log.warn(`overlord round ${round} failed: ${errMsg(err)}`)
        continue
      }
      this.log.info(
        `overlord round ${round}: ${content.length} characters in ${Math.round((Date.now() - started) / 1000)}s`
      )
      messages.push({ role: 'assistant', content })
      let parsed: { site?: number; summary?: string; design?: CastleDesign }
      try {
        parsed = JSON.parse(content) as typeof parsed
      } catch {
        messages.push({
          role: 'user',
          content: 'That was not valid JSON. Answer with the JSON object only.',
        })
        continue
      }
      const index = (parsed.site ?? 1) - 1
      const site = brief.sites[index]
      if (!site || !parsed.design) {
        messages.push({
          role: 'user',
          content: `Answer with { "site": 1 to ${brief.sites.length}, "summary": "...", "design": { ... } }.`,
        })
        continue
      }
      const design = placeOnSite(parsed.design, site)
      const problems = [...validateDesign(design), ...courtProblems(design)]
      if (!problems.length) {
        try {
          compileDesign(design)
        } catch (err) {
          problems.push(`the builders could not read it: ${errMsg(err)}`)
        }
      }
      if (!problems.length) {
        this.log.info(
          `overlord: ${design.name} on site ${index + 1}, accepted after ${round} round(s)`
        )
        return { design, site, rounds: round, summary: parsed.summary ?? '' }
      }
      this.log.info(
        `overlord round ${round}: ${problems.length} problems: ${problems.slice(0, 6).join('; ')}`
      )
      messages.push({
        role: 'user',
        content:
          `The builders found these problems with your design:\n- ${problems.join('\n- ')}\n\n` +
          'Fix every one of them and send the whole corrected JSON again (same form: site, summary, design).',
      })
    }
    this.log.warn(`overlord gave up after ${MAX_ROUNDS} rounds`)
    return null
  }
}
