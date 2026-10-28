/**
 * What players ask the bots to do. Movement requests (follow, come, stop) are detected here and
 * turned into actions. Requests for things the bots cannot do yet are detected too: small
 * models happily promise them anyway ("I shall build you a castle!"), which disappoints a child
 * when nothing happens, so the reply gets a note and promises are caught and replaced.
 *
 * Remove an ability from MissingAbility once the bots can really do it.
 */
import { matchBlueprint, spellbookList, type BlueprintId } from '../build/blueprints'

export type MissingAbility = 'build' | 'fetch' | 'travel'

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

const REQUEST_PATTERNS: Array<[MissingAbility, RegExp]> = [
  ['build', /\b(build|construct|craft|make (me|us))\b/i],
  ['fetch', /\b(bring|fetch|get) (me|us)\b/i],
  ['travel', /\b(go to|run to|fly to|take me to|teleport|tp to)\b/i],
]

const VERBS: Record<MissingAbility, string> = {
  build: `build anything outside your spellbook (${spellbookList()})`,
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
  if (!BUILD_VERB.test(message)) return null
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

/** Transient instruction placed right next to the request in the prompt. */
export function abilityNote(ability: MissingAbility, botName: string): string {
  return (
    `(Note for ${botName}: you cannot ${VERBS[ability]} yet. Do not agree, promise or pretend. ` +
    'Decline kindly in character and offer something else.)'
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
    case 'fetch':
      return `Alas, ${address}, my satchel cannot carry things yet. Tell me what you seek and I will help you think where to find it.`
    case 'travel':
      return `Alas, ${address}, I cannot find places by name yet. But if you lead the way, I shall gladly follow!`
  }
}
