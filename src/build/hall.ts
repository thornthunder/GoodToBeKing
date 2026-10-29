/**
 * Works out a hall the royal family built by hand (in survival) from its walls alone: the room
 * inside, the ring of wall columns around it and how high the walls stand. From that come the
 * jobs the court can do for it: a roof, a floor, light and a door. Pure functions over block names.
 */

/** Block names by position; undefined where the world is not loaded. */
export type BlockNames = (x: number, y: number, z: number) => string | undefined

export interface HandCell {
  x: number
  y: number
  z: number
  /** A block name, or a group any member of which will do ("planks"). */
  block: string
  /** Dig what stands there first (the hall's own dirt floor). */
  replace?: boolean
  /** Place against this neighbour (a torch on a wall). */
  against?: [number, number, number]
  /** A bed: the foot is this cell, the head lies this way (x, z), against the wall. */
  head?: [number, number]
}

export interface Hall {
  /** Feet level inside: the floor blocks are one below. */
  floorY: number
  /** Columns inside the walls, "x,z". */
  inside: Array<[number, number]>
  /** Wall columns around the inside (corners included). */
  ring: Array<[number, number]>
  /** The highest wall block. */
  wallTop: number
  /** Gaps in the wall at feet and head height, where a door could go. */
  openings: Array<[number, number]>
}

/** Neither air nor something a player walks through. */
const OPEN =
  /^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow_layer|torch|wall_torch|[a-z_]*_carpet|[a-z_]*flower|poppy|dandelion|[a-z_]*_tulip|leaf_litter|wildflowers)$/
const DOOR = /_door$/

/** The biggest room the survey accepts, and how far from the home spot it may reach. */
const MAX_INSIDE = 400
const MAX_REACH = 16

const open = (name: string | undefined) => name !== undefined && OPEN.test(name)

/**
 * The hall around the home spot (where the royal stood, inside it). The walls must stand at
 * least three high all round, so a doorway two high does not let the room leak out.
 */
export function surveyHall(
  names: BlockNames,
  home: { x: number; y: number; z: number }
): Hall | string {
  const floorY = Math.floor(home.y)
  const hx = Math.floor(home.x)
  const hz = Math.floor(home.z)
  if (!open(names(hx, floorY, hz))) return 'the home spot is not inside a room'
  // Head height and a block above it: doorways are two high, walls at least three.
  const level = floorY + 2
  const seen = new Set<string>()
  const inside: Array<[number, number]> = []
  const queue: Array<[number, number]> = [[hx, hz]]
  while (queue.length) {
    const [x, z] = queue.pop()!
    const k = `${x},${z}`
    if (seen.has(k)) continue
    seen.add(k)
    if (Math.abs(x - hx) > MAX_REACH || Math.abs(z - hz) > MAX_REACH || inside.length > MAX_INSIDE)
      return 'the walls are not closed all round at three blocks high, so I cannot tell where the hall ends'
    // Open at the third block: inside. A doorway or window is closed there; a chest or a
    // table on the floor is not a wall.
    if (!open(names(x, level, z))) continue
    inside.push([x, z])
    queue.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1])
  }
  const isInside = new Set(inside.map(([x, z]) => `${x},${z}`))
  const ringSet = new Set<string>()
  for (const [x, z] of inside)
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const k = `${x + dx},${z + dz}`
        if (!isInside.has(k)) ringSet.add(k)
      }
  const ring = [...ringSet].map((k) => k.split(',').map(Number) as [number, number])
  // A roof: a ceiling at one height over most of the room. The walls stop under it.
  const ceilings = new Map<number, number>()
  for (const [x, z] of inside) {
    let y = level + 1
    while (y < level + 8 && open(names(x, y, z))) y++
    if (y < level + 8) ceilings.set(y, (ceilings.get(y) ?? 0) + 1)
  }
  const [roofY, under] = [...ceilings].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0]
  const roofed = roofY !== undefined && under > inside.length / 2
  let wallTop = level
  for (const [x, z] of ring) {
    let y = level
    while (y < level + 8 && !open(names(x, y + 1, z)) && !(roofed && y + 1 >= roofY)) y++
    wallTop = Math.max(wallTop, y)
  }
  const openings = ring.filter(
    ([x, z]) =>
      (open(names(x, floorY, z)) || DOOR.test(names(x, floorY, z) ?? '')) &&
      (open(names(x, floorY + 1, z)) || DOOR.test(names(x, floorY + 1, z) ?? ''))
  )
  return { floorY, inside, ring, wallTop, openings }
}

/** A roof one above the highest wall, over the room and the walls, with gaps in the walls closed. */
export function roofCells(hall: Hall, names: BlockNames): HandCell[] {
  const roofY = hall.wallTop + 1
  const cells: HandCell[] = []
  // Walls up to the roof first, so the roof has something to rest on all round.
  // (Above a doorway too: the fill starts above head height.)
  for (const [x, z] of hall.ring) {
    for (let y = hall.floorY + 2; y < roofY; y++)
      if (open(names(x, y, z))) cells.push({ x, y, z, block: 'planks' })
  }
  for (const [x, z] of [...hall.ring, ...hall.inside])
    if (open(names(x, roofY, z))) cells.push({ x, y: roofY, z, block: 'planks' })
  return cells
}

/** A plank floor in place of the earth inside. */
export function floorCells(hall: Hall, names: BlockNames): HandCell[] {
  const y = hall.floorY - 1
  return hall.inside
    .filter(([x, z]) => open(names(x, hall.floorY, z)))
    .filter(([x, z]) => !/_planks$/.test(names(x, y, z) ?? ''))
    .map(([x, z]) => ({ x, y, z, block: 'planks', replace: true }))
}

/** Torches on the inside of the walls, about every five blocks, at head height. */
export function lightCells(hall: Hall, names: BlockNames): HandCell[] {
  const y = hall.floorY + 1
  const isRing = new Set(hall.ring.map(([x, z]) => `${x},${z}`))
  const cells: HandCell[] = []
  // Torches already up count too: none closer than five blocks to another.
  const lit = hall.inside.filter(([x, z]) => /torch/.test(names(x, y, z) ?? ''))
  for (const [x, z] of hall.inside) {
    if (!open(names(x, y, z)) || /torch/.test(names(x, y, z) ?? '')) continue
    if (lit.some(([tx, tz]) => Math.abs(tx - x) + Math.abs(tz - z) < 5)) continue
    const wall = (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const
    ).find(([dx, dz]) => {
      // A solid wall: not a doorway, and not the door in it.
      const wall = names(x + dx, y, z + dz)
      return (
        isRing.has(`${x + dx},${z + dz}`) && wall !== undefined && !open(wall) && !DOOR.test(wall)
      )
    })
    if (!wall) continue
    if (cells.some((c) => Math.abs(c.x - x) + Math.abs(c.z - z) < 5)) continue
    cells.push({ x, y, z, block: 'torch', against: [wall[0], 0, wall[1]] })
  }
  return cells
}

/**
 * Up to `count` beds along the inside of the walls, head against the wall, a gap between them,
 * none in front of a doorway: the foot one block in, the head next to the wall.
 */
export function bedCells(hall: Hall, names: BlockNames, count: number): HandCell[] {
  const y = hall.floorY
  const isInside = new Set(hall.inside.map(([x, z]) => `${x},${z}`))
  const isRing = new Set(hall.ring.map(([x, z]) => `${x},${z}`))
  const nearDoor = (x: number, z: number) =>
    hall.openings.some(([ox, oz]) => Math.abs(ox - x) + Math.abs(oz - z) <= 2)
  const free = (x: number, z: number) =>
    isInside.has(`${x},${z}`) && open(names(x, y, z)) && open(names(x, y + 1, z))
  const used = new Set<string>()
  const cells: HandCell[] = []
  const sides = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const
  for (const [hx, hz] of [...hall.inside].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (cells.length >= count) break
    for (const [dx, dz] of sides) {
      // The head next to a solid wall; the foot one block further in; room to stand behind it.
      const wall = names(hx + dx, y, hz + dz)
      if (!isRing.has(`${hx + dx},${hz + dz}`) || !wall || open(wall) || DOOR.test(wall)) continue
      const [fx, fz] = [hx - dx, hz - dz]
      const [sx, sz] = [fx - dx, fz - dz]
      if (!free(hx, hz) || !free(fx, fz) || !free(sx, sz) || nearDoor(hx, hz)) continue
      const around = [
        [hx, hz],
        [fx, fz],
      ].flatMap(([x, z]) => [`${x},${z}`, `${x + dz},${z + dx}`, `${x - dz},${z - dx}`])
      if (around.some((k) => used.has(k))) continue
      used.add(`${hx},${hz}`)
      used.add(`${fx},${fz}`)
      cells.push({ x: fx, y, z: fz, block: 'bed', head: [dx, dz] })
      break
    }
  }
  return cells
}

/**
 * What is missing from the hall as it was last seen whole: wall blocks (doorways stay open) and,
 * if it has a roof, holes in it. Planks, which endermen cannot carry off as they do dirt.
 */
export function repairCells(hall: Hall, names: BlockNames): HandCell[] {
  const cells: HandCell[] = []
  const doorway = new Set(hall.openings.map(([x, z]) => `${x},${z}`))
  for (const [x, z] of hall.ring)
    for (let y = hall.floorY; y <= hall.wallTop; y++) {
      if (doorway.has(`${x},${z}`) && y <= hall.floorY + 1) continue
      if (open(names(x, y, z))) cells.push({ x, y, z, block: 'planks' })
    }
  const roofY = hall.wallTop + 1
  const roof = [...hall.ring, ...hall.inside]
  const covered = roof.filter(([x, z]) => !open(names(x, roofY, z))).length
  // Mostly roofed: then the gaps are damage, not a roof never built.
  if (covered > roof.length / 2)
    for (const [x, z] of roof)
      if (open(names(x, roofY, z))) cells.push({ x, y: roofY, z, block: 'planks' })
  return cells
}

/** A door in the first opening two high (the item places both halves). */
export function doorCells(hall: Hall, names: BlockNames): HandCell[] {
  const gap = hall.openings.find(([x, z]) => !DOOR.test(names(x, hall.floorY, z) ?? ''))
  return gap ? [{ x: gap[0], y: hall.floorY, z: gap[1], block: 'wooden_door' }] : []
}
