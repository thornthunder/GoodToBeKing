import type { HallWork } from './ai/Brain'
import type { Material } from './bot/gathering'

/**
 * The Castellan's account of what the court needs to look after itself in survival, and what to
 * do about it, most urgent first. Pure: BotManager gathers the state and carries out the plan.
 */
export interface CourtState {
  /** A royal is near the Castellan or Merlin: ask them rather than Merlin. */
  royalNear: boolean
  /** Merlin is online with his magic awake, and how much of the hour's magic is left. */
  merlinAwake: boolean
  magicLeft: number
  /** Guards carrying no sword or axe. */
  guardsUnarmed: string[]
  /** How many courtiers want a bed, and how many beds the hall has. */
  courtiers: number
  bedsInHall: number
  /** A free builder, and one already carrying beds or coal. */
  freeBuilder?: string
  builderWithBeds?: string
  builderWithCoal?: string
  /** What the hall still lacks, in blocks (0 = done). */
  hall: { roof: number; door: number; light: number }
  /** The storehouse holds coal (for torches). */
  storeHasCoal: boolean
  /** Courtiers carrying no food at all. */
  withoutFood: string[]
  /** Wood in the storehouse, in logs (four planks count as one). */
  woodInStore: number
  /** A free member of the staff for errands. */
  freeHand?: string
  /** The court has a storehouse. */
  storehouse: boolean
}

export type StewardAction =
  /** Work on the hall by a builder (`by`: this one). */
  | { kind: 'hallwork'; work: HallWork; by?: string }
  /** Merlin conjures `count` of `item` for `to`; then `to` does `then` with it. */
  | { kind: 'magic'; item: string; count: number; to: string; then?: HallWork; why: string }
  /** Ask the royal family for Merlin's help instead (they are near). */
  | { kind: 'ask'; what: string }
  /** A free hand fetches this for the storehouse. */
  | { kind: 'errand'; material: Material; count: number }

/** Merlin keeps this much of the hour's magic for the royal family. */
export const MAGIC_RESERVE = 2
/** Below this many logs' worth of wood in the storehouse, someone chops more. */
export const WOOD_RESERVE = 12

/**
 * What to do now: at most one piece of hall work, one piece of magic (or a request to the royal
 * family for it) and one errand, each the most urgent of its kind.
 */
export function plan(s: CourtState): StewardAction[] {
  const out: StewardAction[] = []
  // The hall first: a roof keeps arrows and rain out, a door keeps monsters out.
  if (s.freeBuilder) {
    if (s.hall.roof > 0) out.push({ kind: 'hallwork', work: 'roof' })
    else if (s.hall.door > 0) out.push({ kind: 'hallwork', work: 'door' })
    else if (s.builderWithBeds && s.bedsInHall < s.courtiers)
      out.push({ kind: 'hallwork', work: 'beds', by: s.builderWithBeds })
    else if (s.hall.light > 0 && (s.storeHasCoal || s.builderWithCoal))
      out.push({ kind: 'hallwork', work: 'light', by: s.builderWithCoal })
  }
  // Magic: swords, beds, coal, food; only for what the court cannot get by hand.
  const wants: Array<Omit<Extract<StewardAction, { kind: 'magic' }>, 'kind'>> = []
  for (const guard of s.guardsUnarmed)
    wants.push({ item: 'iron_sword', count: 1, to: guard, why: `a sword for ${guard}` })
  const bedsWanted = s.courtiers - s.bedsInHall
  if (bedsWanted > 0 && !s.builderWithBeds && s.freeBuilder)
    wants.push({
      item: 'bed',
      count: Math.min(6, bedsWanted),
      to: s.freeBuilder,
      then: 'beds',
      why: 'beds for the court',
    })
  if (s.hall.light > 0 && !s.storeHasCoal && !s.builderWithCoal && s.freeBuilder)
    wants.push({
      item: 'coal',
      count: 1,
      to: s.freeBuilder,
      then: 'light',
      why: 'coal for torches',
    })
  for (const hungry of s.withoutFood)
    wants.push({ item: 'bread', count: 4, to: hungry, why: `food for ${hungry}` })
  const first = wants[0]
  if (first) {
    if (s.royalNear) out.push({ kind: 'ask', what: first.why })
    else if (s.merlinAwake && s.magicLeft - first.count >= MAGIC_RESERVE)
      out.push({ kind: 'magic', ...first })
  }
  // Wood for the next repairs and planks.
  if (s.storehouse && s.freeHand && s.woodInStore < WOOD_RESERVE)
    out.push({ kind: 'errand', material: 'wood', count: 16 })
  return out
}
