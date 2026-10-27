/**
 * A riddle book. Small models invent riddles whose hints and answers do not fit together, so
 * the bots tell riddles from this list and keep the answer in their prompt while the player
 * guesses. `keywords` are words that count as a correct guess.
 */
export interface Riddle {
  question: string
  answer: string
  keywords: string[]
}

export const RIDDLES: Riddle[] = [
  {
    question: 'What has keys but cannot open any locks?',
    answer: 'a piano',
    keywords: ['piano', 'keyboard'],
  },
  {
    question: 'What has hands and a face, but cannot hold anything or smile?',
    answer: 'a clock',
    keywords: ['clock', 'watch'],
  },
  { question: 'What gets wetter the more it dries?', answer: 'a towel', keywords: ['towel'] },
  { question: 'What has a neck but no head?', answer: 'a bottle', keywords: ['bottle'] },
  {
    question: 'What has many teeth but cannot bite?',
    answer: 'a comb',
    keywords: ['comb', 'zipper', 'saw'],
  },
  { question: 'What can you catch but never throw?', answer: 'a cold', keywords: ['cold'] },
  { question: 'What has one eye but cannot see?', answer: 'a needle', keywords: ['needle'] },
  {
    question: 'What is full of holes but still holds water?',
    answer: 'a sponge',
    keywords: ['sponge'],
  },
  { question: 'What has legs but cannot walk?', answer: 'a table', keywords: ['table', 'chair'] },
  {
    question: 'The more of me you take, the more you leave behind. What am I?',
    answer: 'footsteps',
    keywords: ['footstep', 'steps', 'footprint'],
  },
  {
    question: 'What runs all around a garden but never moves?',
    answer: 'a fence',
    keywords: ['fence', 'wall'],
  },
  {
    question: 'What has a ring but no finger?',
    answer: 'a telephone',
    keywords: ['phone', 'telephone', 'bell'],
  },
  {
    question: 'What can travel all around the world while staying in a corner?',
    answer: 'a stamp',
    keywords: ['stamp'],
  },
  {
    question: 'What is so fragile that saying its name breaks it?',
    answer: 'silence',
    keywords: ['silence', 'quiet'],
  },
  { question: 'What has a bottom at the top?', answer: 'your legs', keywords: ['leg'] },
  { question: 'What has words but never speaks?', answer: 'a book', keywords: ['book'] },
  {
    question: 'What begins with T, ends with T, and has tea in it?',
    answer: 'a teapot',
    keywords: ['teapot'],
  },
  {
    question: 'What kind of band never plays music?',
    answer: 'a rubber band',
    keywords: ['rubber', 'elastic', 'hair'],
  },
  { question: 'What building has the most stories?', answer: 'a library', keywords: ['library'] },
  {
    question: 'I am green, I hiss, and if I get too close I go boom. What am I?',
    answer: 'a creeper',
    keywords: ['creeper'],
  },
  {
    question: 'I glow in the Nether, and torches are my little cousins. What block am I?',
    answer: 'glowstone',
    keywords: ['glowstone'],
  },
  {
    question: 'I am a block that is soft and white, and a sheep gives me to you. What am I?',
    answer: 'wool',
    keywords: ['wool'],
  },
  {
    question: 'I carry you across the ocean in Minecraft and I am made of planks. What am I?',
    answer: 'a boat',
    keywords: ['boat'],
  },
  {
    question: 'I am purple, I teleport, and I do not like it when you look at me. Who am I?',
    answer: 'an Enderman',
    keywords: ['enderman', 'ender'],
  },
  {
    question: 'I come out at night, I wear no armour, and I rattle when I shoot arrows. Who am I?',
    answer: 'a skeleton',
    keywords: ['skeleton'],
  },
  {
    question: 'I am the tool you need to dig diamonds. What am I?',
    answer: 'an iron pickaxe',
    keywords: ['pickaxe', 'pick'],
  },
  {
    question: 'I am orange, I flow, and you should never swim in me. What am I?',
    answer: 'lava',
    keywords: ['lava', 'magma'],
  },
]

/** Phrases that ask the bot for a riddle. */
const REQUEST =
  /\b(riddles?|another one|tell me (one|another)|ask me (one|another|something)|give me (one|another))\b/i
/** A short yes after the bot offered a riddle. */
const YES = /^\W*(yes|yeah|yep|yup|sure|ok|okay|please|go on|go ahead|alright|of course)\b/i

/** True when a message asks for a riddle, or says yes right after the bot offered one. */
export function wantsRiddle(message: string, lastBotLine: string | undefined): boolean {
  if (REQUEST.test(message)) return true
  return Boolean(lastBotLine && /\briddle\b/i.test(lastBotLine) && YES.test(message))
}

/** True when the message contains a word that counts as the right answer. */
export function guessedRiddle(message: string, riddle: Riddle): boolean {
  const text = message.toLowerCase()
  return riddle.keywords.some((k) => new RegExp(`\\b${k}`, 'i').test(text))
}

/** Pick a riddle not told yet (random); starts over once the whole book has been used. */
export function pickRiddle(told: Set<string>, random = Math.random): Riddle {
  let fresh = RIDDLES.filter((r) => !told.has(r.question))
  if (fresh.length === 0) {
    told.clear()
    fresh = RIDDLES
  }
  return fresh[Math.floor(random() * fresh.length)]
}
