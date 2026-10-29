/**
 * What players ask the bots to do. Movement requests (follow, come, stop) are detected here and
 * turned into actions. Requests for things the bots cannot do yet are detected too: small
 * models happily promise them anyway ("I shall build you a castle!"), which disappoints a child
 * when nothing happens, so the reply gets a note and promises are caught and replaced.
 *
 * Remove an ability from MissingAbility once the bots can really do it.
 */
import type { Material } from '../bot/gathering'
import type { HallWork } from './Brain'
import { matchBlueprint, spellbookList, type BlueprintId } from '../build/blueprints'

export type MissingAbility = 'build' | 'handbuild' | 'fetch' | 'travel'

export type MoveCommand = 'follow' | 'come' | 'stop'

const NEGATED_MOVE =
  /\b(don'?t|do not|stop|no more|quit)\b[^.!?]{0,15}\b(follow|following|come|coming)\b/i
const STOP = /\b(stop|stay|wait|halt|freeze|leave me|stand still)\b/i
const FOLLOW = /\b(follow|come with me|walk with me|accompany)\b/i
const COME = /\b(come(?! on\b)|walk over|over here)\b/i

/**
 * A movement command in a chat line. `moving` is whether the bot is walking right now: "stop"
 * and "wait" only mean something then.
 */
export function detectMoveCommand(message: string, moving: boolean): MoveCommand | null {
  if (NEGATED_MOVE.test(message)) return moving ? 'stop' : null
  if (moving && STOP.test(message)) return 'stop'
  if (FOLLOW.test(message)) return 'follow'
  if (COME.test(message)) return 'come'
  return null
}

const GATHER_VERB = /\b(fetch|bring|get|gather|collect|dig|chop|cut)\b/i
const QUESTION = /^\s*(where|how|what|why|who)\b/i
const MATERIAL_WORDS: Array<[Material, RegExp]> = [
  ['dirt', /\b(dirt|soil|earth)\b/i],
  ['wood', /\b(wood|logs?|timber|trees?)\b/i],
  ['sand', /\bsand\b/i],
  ['gravel', /\bgravel\b/i],
]
const NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  dozen: 12,
}

const TO_STORE = /\b(storehouse|stores|store ?room|larder|in(to)? the chest)\b/i
const HOME = [
  /\b(make|call|name)\b[^.!?]{0,30}\bour (new )?home\b/i,
  /\b(this|here)\b[^.!?]{0,30}\b(is|shall be|will be|becomes)\b[^.!?]{0,10}\bour (new )?home\b/i,
  /\bour (new )?home is here\b/i,
]
const STOREHOUSE = [
  /\b(this|that|the)\s+(chest|barrel)\b[^.!?]{0,30}\b(storehouse|store|storage|larder|stores)\b/i,
  /\b(use|make)\b[^.!?]{0,20}\b(chest|barrel)\b[^.!?]{0,30}\b(storehouse|store|storage|larder|stores)\b/i,
  /\b(this|here)\b[^.!?]{0,10}\b(is|shall be|will be)\b[^.!?]{0,10}\b(the|our) (storehouse|larder|stores)\b/i,
]

const HALL_WORK: Array<[HallWork, RegExp]> = [
  ['repair', /\b(repair|mend|fix|patch)\b/i],
  ['roof', /\broof\b/i],
  ['floor', /\bfloor(ing)?\b/i],
  ['door', /\bdoor\b/i],
  ['beds', /\bbeds?\b/i],
  ['furnace', /\bfurnace\b/i],
  ['light', /\b(light|torch|torches|lamps?)\b/i],
]
const HALL_VERB =
  /\b(put|build|make|add|give|lay|cover|fit|hang|place|need|light|finish|set|could|can|please|repair|mend|fix|patch)\b/i

/** "Put a roof on the hall", "lay a floor", "light the hall", "make us a door". */
export function detectHallWork(message: string): HallWork | null {
  if (!HALL_VERB.test(message) || QUESTION.test(message)) return null
  return HALL_WORK.find(([, words]) => words.test(message))?.[0] ?? null
}

/** "This hall is our home", "make it our home". */
export function detectHomeRequest(message: string): boolean {
  return HOME.some((p) => p.test(message))
}

/** "This chest is our storehouse", "use this chest for storage". */
export function detectStorehouseRequest(message: string): boolean {
  return STOREHOUSE.some((p) => p.test(message))
}

/** Fetched when no number is said, and the most for one errand. */
export const FETCH_DEFAULT = 16
export const FETCH_MAX = 64

/** "Henry, fetch me 10 dirt", "chop some wood for us", "get me a stack of sand". */
export function detectGatherRequest(
  message: string
): { material: Material; count: number; toStore?: boolean } | null {
  if (!GATHER_VERB.test(message) || QUESTION.test(message)) return null
  const hit = MATERIAL_WORDS.find(([, words]) => words.test(message))
  if (!hit) return null
  const digits = message.match(/\b(\d{1,3})\b/)
  const word = message
    .toLowerCase()
    .match(
      /\b(a stack|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|dozen)\b/
    )
  const asked = digits
    ? Number(digits[1])
    : word
      ? word[1] === 'a stack'
        ? 64
        : NUMBERS[word[1]]
      : FETCH_DEFAULT
  const count = Math.max(1, Math.min(FETCH_MAX, asked))
  return TO_STORE.test(message)
    ? { material: hit[0], count, toStore: true }
    : { material: hit[0], count }
}

/** "Please have a garden built", "I'd like a tower built here", but not "who built this?" */
const BUILT_FOR_ME = /\b(have|get|want|like|need)\b[^.!?]{0,40}\bbuilt\b/i

const REQUEST_PATTERNS: Array<[MissingAbility, RegExp]> = [
  ['build', /\b(build|construct|craft|make (me|us))\b/i],
  ['build', BUILT_FOR_ME],
  ['fetch', /\b(bring|fetch|get) (me|us)\b/i],
  ['travel', /\b(go to|run to|fly to|take me to|teleport|tp to)\b/i],
]

const VERBS: Record<MissingAbility, string> = {
  build: `build anything outside your spellbook (${spellbookList()})`,
  handbuild:
    'build, take down or start great works in this world, where every block must be gathered ' +
    'and laid by hand (the court only knows building by creative magic so far)',
  fetch: 'fetch, carry or hand over items',
  travel: 'find places by name or teleport',
}

const BUILD_VERB = /\b(build|construct|make|create|raise|put up)\b/i
const ANYTHING = /\b(something|anything|whatever)\b/i

/**
 * A request to build. `blueprint` is the spellbook entry it names (or 'tower' for "build me
 * something"); null when it names something the spellbook does not hold.
 */
export function detectBuildRequest(message: string): { blueprint: BlueprintId | null } | null {
  if (!BUILD_VERB.test(message) && !BUILT_FOR_ME.test(message)) return null
  const named = matchBlueprint(message)
  if (named) return { blueprint: named }
  return { blueprint: ANYTHING.test(message) ? 'tower' : null }
}

/** A whole new castle: more than any blueprint, designed by the master builder for the spot. */
const GREAT_WORKS =
  /\b(palace|fortress|citadel|stronghold|(?:new|another|second|third|big|bigger|great|grand|huge|giant|real|whole) castle)\b/i
/** "at 120 70 -340", "near x 120 z -340": a place given by its coordinates. */
const COORDINATES =
  /\b(?:at|near|around|on)\s+(?:the\s+)?(?:coordinates?\s+)?(?:x\s*=?\s*)?(-?\d+)[\s,]+(?:y\s*=?\s*|z\s*=?\s*)?(-?\d+)(?:[\s,]+(?:z\s*=?\s*)?(-?\d+))?/i

export interface WorksRequest {
  /** "palace", "castle", "fortress"... */
  what: string
  /** Where, when given by coordinates (y may be left out); otherwise where the royal stands. */
  at?: { x: number; y?: number; z: number }
}

/** A request for great works: a new palace or castle, here or at the coordinates given. */
export function detectWorksRequest(message: string): WorksRequest | null {
  if (!BUILD_VERB.test(message)) return null
  const works = GREAT_WORKS.exec(message)
  if (!works) return null
  const what = works[1].split(/\s+/).at(-1)!.toLowerCase()
  const c = COORDINATES.exec(message)
  if (!c) return { what }
  const [x, second, third] = [c[1], c[2], c[3]].map((n) =>
    n === undefined ? undefined : Number(n)
  )
  return {
    what,
    at: third === undefined ? { x: x!, z: second! } : { x: x!, y: second, z: third },
  }
}

const UNDO =
  /\b(take (it|that|this) down|tear (it|that|this) down|knock (it|that|this) down|remove (it|that|this|the \w+)|get rid of (it|that|this)|undo)\b/i

/** A request to take down the last thing the bot built. */
export function detectUndoRequest(message: string): boolean {
  return UNDO.test(message)
}

/** Which missing ability, if any, a chat line asks for. */
export function detectMissingAbility(message: string): MissingAbility | null {
  for (const [ability, pattern] of REQUEST_PATTERNS) {
    if (pattern.test(message)) return ability
  }
  return null
}

const SUBJECT = String.raw`(?:i|i'll|i will|i shall|i am|i'm|let me|let us|let's|we shall|we will|shall we)`
const ACTION = String.raw`(?:on my way|build|building|construct|raise|craft|bring|fetch|carry|teleport|fly there|go there|take you there)`
const PROMISE = new RegExp(String.raw`\b${SUBJECT}\b[^.!?]{0,40}?\b${ACTION}\b`, 'i')
const REFUSAL =
  /\b(can't|cannot|can not|not yet|just yet|unable|not able|must stay|must remain|stay here|not ready|still being|slumbering|(do not|don't) (possess|have) the means)\b/i

/** True when a reply agrees to or claims an action the bot cannot perform. */
export function promisesAction(reply: string): boolean {
  return PROMISE.test(reply) && !REFUSAL.test(reply)
}

/** True when a reply turns the request down, or says it cannot be done yet. */
export function refuses(reply: string): boolean {
  return REFUSAL.test(reply) || /\b(by hand|not (yet )?learned|haven't learned)\b/i.test(reply)
}

/** What the court can truly offer instead (anything else would be one more empty promise). */
const OFFERS: Partial<Record<MissingAbility, string>> = {
  handbuild:
    'offer only what the court can really do here: fetch dirt, wood, sand or gravel, put a ' +
    "roof, a floor, a door or torches on the court's home hall, or keep them company",
}

/** Transient instruction placed right next to the request in the prompt. */
export function abilityNote(ability: MissingAbility, botName: string): string {
  return (
    `(Note for ${botName}: you cannot ${VERBS[ability]} yet. Do not agree, promise or pretend. ` +
    `Decline kindly in character and ${OFFERS[ability] ?? 'offer something else'}.)`
  )
}

/**
 * In-character decline used when the model promised the impossible anyway. `magic`: the bot
 * builds from a spellbook (Merlin); the others speak of the court's builders.
 */
export function declineLine(ability: MissingAbility, address: string, magic = false): string {
  switch (ability) {
    case 'build':
      return magic
        ? `Alas, ${address}, my spellbook does not hold that yet. It holds ${spellbookList()}: which would please you?`
        : `Alas, ${address}, that is beyond the court's builders for now. They can raise ${spellbookList()}: which would please you?`
    case 'handbuild':
      return `Alas, ${address}, in this world every block must be gathered and laid by hand, and the court has not learned to build that way yet. But we can fetch you dirt, wood, sand or gravel!`
    case 'fetch':
      return `Alas, ${address}, my satchel cannot carry things yet. Tell me what you seek and I will help you think where to find it.`
    case 'travel':
      return `Alas, ${address}, I cannot find places by name yet. But if you lead the way, I shall gladly follow!`
  }
}
