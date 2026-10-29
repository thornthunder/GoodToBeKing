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
  /** The storehouse chest was there once and is gone (blown up): a new one is wanted. */
  storehouseLost?: boolean
  /** What the hall still lacks, in blocks (0 = done); `repair`: holes against its known shape. */
  hall: { roof: number; door: number; light: number; repair: number }
  /** The storehouse holds coal (for torches). */
  storeHasCoal: boolean
  /** Courtiers carrying no food at all. */
  withoutFood: string[]
  /** Meals in the storehouse (cooked meat, bread...), and raw meat waiting to be cooked. */
  foodInStore: number
  rawInStore: number
  /** The hall has a furnace; a builder carries one to put in. */
  furnace: boolean
  builderWithFurnace?: string
  /** A free courtier to hunt (a guard first, they carry swords). */
  freeHunter?: string
  /** The wheat field: whether there is one, and how many squares want work now. */
  farm: { exists: boolean; work: number }
  /** Wheat seeds the court has (storehouse and pockets). */
  seeds: number
  /** Wood in the storehouse, in logs (four planks count as one). */
  woodInStore: number
  /** A free member of the staff for errands. */
  freeHand?: string
  /** The court has a storehouse. */
  storehouse: boolean
  /** Night: monsters about, nobody goes out (only work indoors). */
  night: boolean
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
  /** Hunt this many animals for meat (by the King's rule), into the storehouse. */
  | { kind: 'hunt'; animals: number; by: string }
  /** Cook the storehouse's raw meat in the hall's furnace. */
  | { kind: 'cook'; by: string }
  /** Charcoal from the storehouse's logs (for torches, without coal). */
  | { kind: 'charcoal'; by: string }
  /** Lay out the wheat field, or tend it (till, plant, harvest, bake). */
  | { kind: 'farm'; by: string }

/** Merlin keeps this much of the hour's magic for the royal family. */
export const MAGIC_RESERVE = 2
/** Below this many logs' worth of wood in the storehouse, someone chops more. */
export const WOOD_RESERVE = 12
/** Below this many meals in the storehouse, someone cooks or hunts. */
export const FOOD_RESERVE = 8

/**
 * What to do now: at most one piece of hall work, one piece of magic (or a request to the royal
 * family for it) and one errand, each the most urgent of its kind.
 */
export function plan(s: CourtState): StewardAction[] {
  const out: StewardAction[] = []
  // The hall first: a roof keeps arrows and rain out, a door keeps monsters out.
  if (s.freeBuilder) {
    // A hall with holes lets the monsters in: mend it before anything else.
    if (s.hall.repair > 0) out.push({ kind: 'hallwork', work: 'repair' })
    else if (s.storehouseLost) out.push({ kind: 'hallwork', work: 'chest' })
    else if (s.hall.roof > 0) out.push({ kind: 'hallwork', work: 'roof' })
    else if (s.hall.door > 0) out.push({ kind: 'hallwork', work: 'door' })
    else if (s.builderWithBeds && s.bedsInHall < s.courtiers)
      out.push({ kind: 'hallwork', work: 'beds', by: s.builderWithBeds })
    else if (s.hall.light > 0 && (s.storeHasCoal || s.builderWithCoal))
      out.push({ kind: 'hallwork', work: 'light', by: s.builderWithCoal })
    else if (s.builderWithFurnace && !s.furnace)
      out.push({ kind: 'hallwork', work: 'furnace', by: s.builderWithFurnace })
  }
  // Light without coal: charcoal from the court's own logs, in the furnace (indoor work).
  const coal = s.storeHasCoal || Boolean(s.builderWithCoal)
  if (s.hall.light > 0 && !coal && s.furnace && s.woodInStore >= 2 && s.freeHand && s.storehouse)
    out.push({ kind: 'charcoal', by: s.freeHand })
  // The field first: bread is the court's food for good (hunting thins the animals out).
  const charcoaling = out.some((a) => a.kind === 'charcoal')
  const farmer =
    !charcoaling &&
    !s.night &&
    s.storehouse &&
    s.freeHand &&
    (s.farm.exists ? s.farm.work > 0 : s.seeds > 0)
      ? s.freeHand
      : undefined
  if (farmer) out.push({ kind: 'farm', by: farmer })
  // Food by hand: cook what was hunted, or hunt.
  const hungry = s.foodInStore < FOOD_RESERVE
  if (hungry && s.storehouse && s.freeHunter && s.freeHunter !== farmer) {
    if (s.rawInStore > 0 && s.furnace) out.push({ kind: 'cook', by: s.freeHunter })
    else if (s.rawInStore < FOOD_RESERVE && !s.night)
      out.push({ kind: 'hunt', animals: 3, by: s.freeHunter })
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
  // Seeds, once, to start the field (after that it gives its own).
  if (!s.farm.exists && s.seeds === 0 && s.freeHand && s.storehouse)
    wants.push({ item: 'wheat_seeds', count: 8, to: s.freeHand, why: 'seeds for a wheat field' })
  // A furnace, once, so the meat can be cooked.
  if (!s.furnace && !s.builderWithFurnace && s.freeBuilder && s.storehouse)
    wants.push({
      item: 'furnace',
      count: 1,
      to: s.freeBuilder,
      then: 'furnace',
      why: 'a furnace for the hall',
    })
  // Coal by magic only when there is no furnace to make charcoal in.
  if (s.hall.light > 0 && !coal && !s.furnace && s.freeBuilder)
    wants.push({
      item: 'coal',
      count: 1,
      to: s.freeBuilder,
      then: 'light',
      why: 'coal for torches',
    })
  // Bread by magic only when there is nothing in store, cooked or raw, to eat.
  if (s.foodInStore === 0 && s.rawInStore === 0)
    for (const hungry of s.withoutFood)
      wants.push({ item: 'bread', count: 4, to: hungry, why: `food for ${hungry}` })
  const first = wants[0]
  if (first) {
    if (s.royalNear) out.push({ kind: 'ask', what: first.why })
    else if (s.merlinAwake && s.magicLeft - first.count >= MAGIC_RESERVE)
      out.push({ kind: 'magic', ...first })
  }
  // Wood for the next repairs and planks.
  if (s.storehouse && s.freeHand && s.woodInStore < WOOD_RESERVE && !s.night)
    out.push({ kind: 'errand', material: 'wood', count: 16 })
  return out
}
