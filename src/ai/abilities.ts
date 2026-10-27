/**
 * What players ask the bots to do. Movement requests (follow, come, stop) are detected here and
 * turned into actions. Requests for things the bots cannot do yet are detected too: small
 * models happily promise them anyway ("I shall build you a castle!"), which disappoints a child
 * when nothing happens, so the reply gets a note and promises are caught and replaced.
 *
 * Remove an ability from MissingAbility once the bots can really do it.
 */
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
  build: 'build or craft anything',
  fetch: 'fetch, carry or hand over items',
  travel: 'find places by name or teleport',
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
  /\b(can't|cannot|can not|not yet|unable|not able|must stay|must remain|stay here|not ready|still being|slumbering)\b/i

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

/** In-character decline used when the model promised the impossible anyway. */
export function declineLine(ability: MissingAbility, address: string): string {
  switch (ability) {
    case 'build':
      return `Alas, ${address}, my building magic is still slumbering. Until it wakes, shall we dream up the design together?`
    case 'fetch':
      return `Alas, ${address}, my satchel cannot carry things yet. Tell me what you seek and I will help you think where to find it.`
    case 'travel':
      return `Alas, ${address}, I cannot find places by name yet. But if you lead the way, I shall gladly follow!`
  }
}
