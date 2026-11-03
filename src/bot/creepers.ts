/**
 * Creepers and the hall (the King's rule, 2026-11-03): a creeper that gets into the hall is a
 * serious matter (one blew up Blue's chest and two courtiers in it; another cratered Green's
 * floor so deep its raiders never got out). One near the hall is lured away by a courtier who
 * goes to meet it and leads it off, at its own risk; one inside has everyone leave, so it follows
 * them out. Pure helpers here; the walking is in bot/survival.ts, the choosing in BotManager.
 */

/** A creeper this close to home is lured away. */
export const CREEPER_WATCH = 16
/** The lure leads it this far from home before turning back. */
export const LURE_FAR = 30
/** A lure is kept to its creeper this long at most before another may be chosen. */
export const LURE_MS = 90_000

export interface Point3 {
  x: number
  y: number
  z: number
}

export interface LureCandidate {
  name: string
  /** A soldier or guard: the first choice. */
  soldier: boolean
  /** The captain (the Castellan): the last choice. */
  captain: boolean
  health?: number
  /** Blocks from the creeper. */
  distance: number
  /** Raiding the other side's chest, or otherwise not to be called: never. */
  unavailable?: boolean
}

/** Health below which a courtier is not sent to meet a creeper unless nobody else can. */
const FIT = 8

/**
 * Who goes to meet the creeper: a fit soldier, the nearest first; else anyone fit but the
 * captain; else whoever is best off. Nobody when everyone is unavailable.
 */
export function chooseLure(candidates: LureCandidate[]): string | undefined {
  const free = candidates.filter((c) => !c.unavailable)
  const fit = (c: LureCandidate) => (c.health ?? 20) >= FIT
  const nearest = (cs: LureCandidate[]) => [...cs].sort((a, b) => a.distance - b.distance)[0]
  return (
    nearest(free.filter((c) => c.soldier && fit(c)))?.name ??
    nearest(free.filter((c) => !c.captain && fit(c)))?.name ??
    [...free].sort((a, b) => (b.health ?? 20) - (a.health ?? 20))[0]?.name
  )
}

/**
 * Where the lure leads the creeper: out from home past the creeper, LURE_FAR from home. A
 * creeper at home itself (inside the hall) is led out through the doorway.
 */
export function lurePoint(
  home: Point3,
  creeper: Point3,
  doorway?: { x: number; z: number }
): Point3 {
  let dx = creeper.x - home.x
  let dz = creeper.z - home.z
  if (Math.hypot(dx, dz) < 5 && doorway) {
    dx = doorway.x - home.x
    dz = doorway.z - home.z
  }
  if (Math.hypot(dx, dz) < 0.5) dz = 1
  const k = LURE_FAR / Math.hypot(dx, dz)
  return { x: Math.round(home.x + dx * k), y: home.y, z: Math.round(home.z + dz * k) }
}
