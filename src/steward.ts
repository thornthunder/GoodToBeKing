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
  /** Every free builder: each takes the next hall job down the list in the same round. */
  freeBuilders?: string[]
  /** Every free member of the staff (builders and guards too): the pool the round's work comes from. */
  freeHands?: string[]
  /** The guards (they hunt first, and do not farm). */
  guards?: string[]
  builderWithBeds?: string
  builderWithCoal?: string
  /** The storehouse chest was there once and is gone (blown up): a new one is wanted. */
  storehouseLost?: boolean
  /** What the hall still lacks, in blocks (0 = done); `repair`: holes against its known shape. */
  hall: {
    roof: number
    door: number
    light: number
    repair: number
    earth?: number
    /** The hall has a crafting table to craft at. */
    table?: boolean
  }
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
  /** The grove: whether there is one, trees grown to fell, bare spots to plant. */
  grove?: { exists: boolean; fell: number; plant: number }
  /** Saplings the court has (storehouse and pockets). */
  saplings?: number
  /** Fishing: a rod to hand (storehouse or a free courtier), string in the storehouse (two make one). */
  fishing?: { rod: boolean; string: number }
  /** Ore in the storehouse to smelt (raw iron, copper, gold), and iron ingots. */
  oreInStore?: number
  ironInStore?: number
  /** Guards an iron sword or a piece of iron armour would make better (iron to be had). */
  guardsToOutfit?: string[]
  /** Wool in the storehouse: three make a bed (with three planks). */
  woolInStore?: number
  /** A courtier carrying saplings: the one to plant them. */
  withSaplings?: string
  /** Cobblestone in the storehouse (the furnace and stone tools need it). */
  cobblestone: number
  /** Any stone in the storehouse, cobblestone included (andesite and the like do for walls). */
  stone?: number
  /** The court's mine has ended for good (water, lava, a cave, deep enough): no more stone from it. */
  mineEnded: boolean
  /** Wood in the storehouse, in logs (four planks count as one). */
  woodInStore: number
  /** A free member of the staff for errands. */
  freeHand?: string
  /** The court has a storehouse. */
  storehouse: boolean
  /** Night: monsters about, nobody goes out (only work indoors). */
  night: boolean
  /**
   * Work that came to nothing lately and rests a while: 'wood', 'hunt', 'farm', 'mine', or
   * 'hallwork:<work>'. No wood to be found nearby makes Merlin's logs the way out.
   */
  resting?: string[]
  /** Work someone is doing right now ('hallwork:<work>', 'mine', 'farm'): not given out twice. */
  underway?: string[]
}

export type StewardAction =
  /** Work on the hall by a builder (`by`: this one; planned work always names one). */
  | { kind: 'hallwork'; work: HallWork; by?: string }
  /** Merlin conjures `count` of `item` for `to`; then `to` does `then` with it. */
  | { kind: 'magic'; item: string; count: number; to: string; then?: HallWork; why: string }
  /** Ask the royal family for Merlin's help instead (they are near). */
  | { kind: 'ask'; what: string }
  /** A free hand fetches this for the storehouse. */
  | { kind: 'errand'; material: Material; count: number; by?: string }
  /** Hunt this many animals for meat (by the King's rule), into the storehouse. */
  | { kind: 'hunt'; animals: number; by: string }
  /** Cook the storehouse's raw meat in the hall's furnace. */
  | { kind: 'cook'; by: string }
  /** Charcoal from the storehouse's logs (for torches, without coal). */
  | { kind: 'charcoal'; by: string }
  /** Smelt the storehouse's ore into ingots in the hall's furnace. */
  | { kind: 'smelt'; by: string }
  /** Dig the court's mine on for cobblestone (and ore). */
  | { kind: 'mine'; by: string; want: number }
  /** A guard makes himself a sword (stone, or wood without cobblestone). */
  | { kind: 'arm'; by: string }
  /** Lay out the wheat field, or tend it (till, plant, harvest, bake). */
  | { kind: 'farm'; by: string }
  /** Fish a while for the court's food. */
  | { kind: 'fish'; by: string }
  /** Tend the grove: fell what has grown, plant the bare spots. */
  | { kind: 'forest'; by: string }

/** Merlin keeps this much of the hour's magic for the royal family. */
export const MAGIC_RESERVE = 2
/** Below this many logs' worth of wood in the storehouse, someone chops more. */
export const WOOD_RESERVE = 12
/** Below this, wood comes before the field and the mine: tools begin with planks. */
export const WOOD_LOW = 4
/** Below this many meals in the storehouse, someone cooks or hunts. */
export const FOOD_RESERVE = 8
/** Below this much cobblestone in the storehouse, someone mines. */
export const STONE_RESERVE = 32

/**
 * What to do now: at most one piece of hall work, one piece of magic (or a request to the royal
 * family for it) and one errand, each the most urgent of its kind.
 */
export function plan(s: CourtState): StewardAction[] {
  const out: StewardAction[] = []
  /** Came to nothing lately (and so may call for magic). */
  const failed = (kind: string) => (s.resting ?? []).includes(kind)
  /** Not to be given out now: resting, or someone is at it. */
  const rests = (kind: string) => failed(kind) || (s.underway ?? []).includes(kind)
  // One pool of free courtiers: each job takes someone not yet given work this round.
  const builders = s.freeBuilders ?? (s.freeBuilder ? [s.freeBuilder] : [])
  const free = new Set<string>([...(s.freeHands ?? (s.freeHand ? [s.freeHand] : [])), ...builders])
  const take = (name?: string) => (name && free.delete(name) ? name : undefined)
  const builder = () => take(builders.find((b) => free.has(b)))
  /** Anyone free, these first (guards hunt, builders build). */
  const anyone = (first: string[] = [], last: string[] = []) =>
    take(first.find((n) => free.has(n))) ??
    take([...free].find((n) => !last.includes(n))) ??
    take([...free][0])

  // The hall first, most urgent first: each job to a free builder (or the one carrying its stuff).
  const jobs: Array<{ work: HallWork; by?: string }> = []
  // A hall with holes lets the monsters in: mend it before anything else.
  if (s.hall.repair > 0) jobs.push({ work: 'repair' })
  // Without a storehouse nothing else can be kept: mining, farming, cooking all wait for it.
  if (s.storehouseLost) jobs.push({ work: 'chest' })
  // A roof keeps arrows and rain out, a door keeps monsters out.
  if (s.hall.roof > 0) jobs.push({ work: 'roof' })
  if (s.hall.door > 0) jobs.push({ work: 'door' })
  // A crafting table in the hall: everyone crafts at it instead of making their own each time.
  if (s.hall.table === false && s.storehouse && s.woodInStore >= 1) jobs.push({ work: 'table' })
  // Beds, so the court wakes at home after a bad night: carried ones, or made of the hunt's wool.
  const woolForBeds = (s.woolInStore ?? 0) >= 3 && s.woodInStore >= 1 && s.storehouse
  if ((s.builderWithBeds || woolForBeds) && s.bedsInHall < s.courtiers)
    jobs.push({ work: 'beds', by: s.builderWithBeds })
  if (s.hall.light > 0 && (s.storeHasCoal || s.builderWithCoal))
    jobs.push({ work: 'light', by: s.builderWithCoal })
  // The court's own furnace: eight cobblestone (or one Merlin conjured).
  if (s.builderWithFurnace && !s.furnace) jobs.push({ work: 'furnace', by: s.builderWithFurnace })
  else if (!s.furnace && s.cobblestone >= 8 && s.storehouse) jobs.push({ work: 'furnace' })
  // Stone for the dirt in walls and roof (endermen, creepers), with stone to spare after the furnace.
  // (Only once the furnace stands: its eight cobblestone come first.)
  if ((s.hall.earth ?? 0) > 0 && s.furnace && (s.stone ?? s.cobblestone) >= 8 && s.storehouse)
    jobs.push({ work: 'reinforce' })
  for (const job of jobs) {
    if (rests(`hallwork:${job.work}`)) continue
    const by = job.by ? take(job.by) : builder()
    if (by) out.push({ kind: 'hallwork', work: job.work, by })
  }

  // The grove: wood from home, safe by day, felled and planted again; before trees far off.
  const saplings = s.saplings ?? 0
  const grove = s.grove
  const groveWork = grove?.exists
    ? grove.fell > 0 || (grove.plant > 0 && saplings > 0)
    : saplings >= 3
  if (groveWork && s.storehouse && !s.night && !rests('forest')) {
    const by = take(s.withSaplings) ?? anyone([], s.guards ?? [])
    if (by) out.push({ kind: 'forest', by })
  }
  // Almost no wood: every tool, table and chest begins with planks, so wood comes first.
  const woodFirst = s.storehouse && s.woodInStore < WOOD_LOW && !s.night && !rests('wood')
  if (woodFirst) {
    const by = anyone([], s.guards ?? [])
    if (by) out.push({ kind: 'errand', material: 'wood', count: 16, by })
  }
  // Light without coal: charcoal from the court's own logs, in the furnace (indoor work).
  const coal = s.storeHasCoal || Boolean(s.builderWithCoal)
  if (s.hall.light > 0 && !coal && s.furnace && s.woodInStore >= 2 && s.storehouse) {
    const by = anyone()
    if (by) out.push({ kind: 'charcoal', by })
  }
  // Stone first while there is no furnace: it unlocks the furnace, charcoal and stone walls.
  const stoneFirst =
    s.storehouse && !s.night && !s.mineEnded && !rests('mine') && !s.furnace && s.cobblestone < 8
  if (stoneFirst) {
    const by = anyone()
    if (by) out.push({ kind: 'mine', by, want: 16 })
  }
  // The field: bread is the court's food for good (hunting thins the animals out).
  if (
    !s.night &&
    s.storehouse &&
    !rests('farm') &&
    (s.farm.exists ? s.farm.work > 0 : s.seeds > 0)
  ) {
    const by = anyone([], s.guards ?? [])
    if (by) out.push({ kind: 'farm', by })
  }
  // Fishing: food that never runs out (the game near home does), by day, not a guard first.
  const canFish = Boolean(s.fishing?.rod) || (s.fishing?.string ?? 0) >= 2
  const hungry = s.foodInStore < FOOD_RESERVE && s.rawInStore < FOOD_RESERVE
  if (hungry && canFish && s.storehouse && !s.night && !rests('fish')) {
    const by = anyone([], s.guards ?? [])
    if (by) out.push({ kind: 'fish', by })
  }
  // Food by hand: cook what was hunted, or hunt (guards first: they carry swords).
  if (s.foodInStore < FOOD_RESERVE && s.storehouse) {
    if (s.rawInStore > 0 && s.furnace) {
      const by = anyone(s.guards ?? (s.freeHunter ? [s.freeHunter] : []))
      if (by) out.push({ kind: 'cook', by })
    } else if (s.rawInStore < FOOD_RESERVE && !s.night && !rests('hunt')) {
      const by = anyone(s.guards ?? (s.freeHunter ? [s.freeHunter] : []))
      if (by) out.push({ kind: 'hunt', animals: 3, by })
    }
  }
  // The iron age: ore from the mine smelted into ingots (indoor work, by night too).
  if (
    (s.oreInStore ?? 0) > 0 &&
    s.furnace &&
    s.woodInStore >= 1 &&
    s.storehouse &&
    !rests('smelt')
  ) {
    const by = anyone()
    if (by) out.push({ kind: 'smelt', by })
  }
  // Guards arm themselves: a stone sword (or a wooden one) from the storehouse's materials, and
  // with iron to be had an iron sword and iron armour.
  const canArm = s.storehouse && (s.cobblestone >= 2 || s.woodInStore >= 1)
  const outfit = s.storehouse && (s.ironInStore ?? 0) >= 2 ? (s.guardsToOutfit ?? []) : []
  const armer = rests('arm')
    ? undefined
    : ((canArm
        ? s.guardsUnarmed.find((g) => free.has(g) || !(s.freeHands ?? []).length)
        : undefined) ?? outfit.find((g) => free.has(g)))
  if (armer) {
    take(armer)
    out.push({ kind: 'arm', by: armer })
  }

  // Magic: swords, beds, seeds, a furnace, coal, food; only for what the court cannot get by hand.
  const someBuilder = builders.find((b) => free.has(b)) ?? s.freeBuilder
  const someone = someBuilder ?? [...free][0] ?? s.freeHand
  const wants: Array<Omit<Extract<StewardAction, { kind: 'magic' }>, 'kind'>> = []
  // The storehouse lost and no wood to make a chest of: everything else waits on it.
  if (s.storehouseLost && failed('hallwork:chest') && someBuilder)
    wants.push({
      item: 'chest',
      count: 1,
      to: someBuilder,
      then: 'chest',
      why: 'a chest for the storehouse',
    })
  // No wood to be had nearby and hardly any in store: everything waits on it, so Merlin's first.
  if (failed('wood') && s.woodInStore < WOOD_LOW && someone)
    wants.push({ item: 'oak_log', count: 4, to: someone, why: 'wood for the court' })
  // No trees left near enough to find, no grove and no saplings: saplings to start one (once
  // the logs have come: a grove takes an hour to grow).
  if (failed('wood') && !grove?.exists && saplings === 0 && someone && s.storehouse)
    wants.push({ item: 'birch_sapling', count: 4, to: someone, why: 'saplings for a grove' })
  if (!canArm)
    for (const guard of s.guardsUnarmed)
      wants.push({ item: 'iron_sword', count: 1, to: guard, why: `a sword for ${guard}` })
  const bedsWanted = s.courtiers - s.bedsInHall
  if (bedsWanted > 0 && !s.builderWithBeds && !woolForBeds && someBuilder)
    wants.push({
      item: 'bed',
      count: Math.min(6, bedsWanted),
      to: someBuilder,
      then: 'beds',
      why: 'beds for the court',
    })
  // Seeds, once, to start the field (after that it gives its own).
  if (!s.farm.exists && s.seeds === 0 && someone && s.storehouse)
    wants.push({ item: 'wheat_seeds', count: 8, to: someone, why: 'seeds for a wheat field' })
  // A furnace by magic only when the court cannot mine the stone for one.
  if (!s.furnace && !s.builderWithFurnace && someBuilder && s.storehouse && s.mineEnded)
    wants.push({
      item: 'furnace',
      count: 1,
      to: someBuilder,
      then: 'furnace',
      why: 'a furnace for the hall',
    })
  // Coal by magic only when there is no furnace to make charcoal in.
  if (s.hall.light > 0 && !coal && !s.furnace && someBuilder)
    wants.push({ item: 'coal', count: 1, to: someBuilder, then: 'light', why: 'coal for torches' })
  // A fishing rod when no game is to be found and no string to make one of: food for good.
  if (hungry && !canFish && failed('hunt') && someone && s.storehouse)
    wants.push({ item: 'fishing_rod', count: 1, to: someone, why: 'a fishing rod for the court' })
  // Bread by magic only when there is nothing in store, cooked or raw, to eat.
  if (s.foodInStore === 0 && s.rawInStore === 0)
    for (const hungry of s.withoutFood)
      wants.push({ item: 'bread', count: 4, to: hungry, why: `food for ${hungry}` })
  // The most urgent want; from Merlin, the most urgent he can still grant this hour.
  const first = wants[0]
  const affordable = wants.find((w) => s.magicLeft - w.count >= MAGIC_RESERVE)
  if (first && s.royalNear) out.push({ kind: 'ask', what: first.why })
  else if (affordable && s.merlinAwake) out.push({ kind: 'magic', ...affordable })

  // Stone: the mine, by day.
  if (
    !stoneFirst &&
    s.storehouse &&
    !s.night &&
    !s.mineEnded &&
    !rests('mine') &&
    s.cobblestone < STONE_RESERVE
  ) {
    const by = anyone()
    if (by) out.push({ kind: 'mine', by, want: 24 })
  }
  // Wood for the next repairs and planks.
  if (!woodFirst && !rests('wood') && s.storehouse && s.woodInStore < WOOD_RESERVE && !s.night) {
    const by = anyone()
    if (by) out.push({ kind: 'errand', material: 'wood', count: 16, by })
  }
  return out
}
