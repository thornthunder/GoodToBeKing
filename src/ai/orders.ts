import fs from 'node:fs'
import path from 'node:path'

/**
 * The court's own laws. They stand above every order and every rule a royal lays down: an order
 * that breaks one is declined, whoever gives it.
 */
export const COURT_LAWS = [
  'Keep everything kind, cheerful and safe for a young child.',
  'Never break, take or change anything a player built or owns.',
  'Never hurt a player or their animals.',
  'Use no powers beyond your own: only Merlin works magic, and only the spells he knows.',
]

/** What the body does to keep a standing order: walk after someone, or stay put. */
export type Post = { type: 'follow'; target: string } | { type: 'stay' }

/** A standing order given to one bot. It stands until it is released. */
export interface Order {
  /** "O3"; shown to the model so it can say which orders a new one clashes with. */
  id: string
  /** Who gave it: a player name or a courtier's name. */
  from: string
  /** The giver as prompts name them, e.g. "the King". */
  by: string
  /** What to do, as a short instruction, e.g. "Stay by the castle gate." */
  text: string
  /** Set when keeping the order keeps the body busy (no building works, no escort duty). */
  post?: Post
  at: number
}

/** A rule a royal laid down for the whole court. */
export interface Rule {
  /** "R2" */
  id: string
  from: string
  by: string
  text: string
  at: number
}

/** Royal precedence by court role; courtiers giving orders rank below every royal. */
const RANKS: Record<string, number> = { king: 3, queen: 3, prince: 2, princess: 2 }

export function rankOf(role: string | undefined): number {
  if (!role) return 0
  return RANKS[role.toLowerCase()] ?? 1
}

/** Something a new order or rule clashes with. */
export interface Clash {
  id: string
  /** Rank of whoever gave it; laws have none (they always win). */
  rank: number
  law?: boolean
}

export type Verdict =
  | { kind: 'accept'; replaces: string[] }
  | { kind: 'confirm'; clashes: string[] }
  | { kind: 'decline'; clashes: string[] }

/**
 * What to do with an order or rule that clashes with others. Court law always wins. The highest
 * royal (the King) is asked to confirm before anything they ordered earlier, or anyone else's
 * order, is set aside. Anyone else is turned down when a clashing order came from above them;
 * otherwise the newest order wins.
 */
export function judge(giverRank: number, topRank: number, clashes: Clash[]): Verdict {
  if (clashes.length === 0) return { kind: 'accept', replaces: [] }
  const laws = clashes.filter((c) => c.law)
  if (laws.length) return { kind: 'decline', clashes: laws.map((c) => c.id) }
  if (giverRank >= topRank) return { kind: 'confirm', clashes: clashes.map((c) => c.id) }
  const above = clashes.filter((c) => c.rank > giverRank)
  if (above.length) return { kind: 'decline', clashes: above.map((c) => c.id) }
  return { kind: 'accept', replaces: clashes.map((c) => c.id) }
}

interface BookData {
  next: number
  orders: Order[]
  /** What this bot still has to tell its superior (orders it took straight from a royal). */
  reports: string[]
}

/** One bot's standing orders and the reports it owes its superior. File-backed. */
export class OrderBook {
  private data: BookData = { next: 1, orders: [], reports: [] }

  constructor(
    private readonly file?: string,
    private readonly max = 12
  ) {
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BookData>
        this.data = {
          next: parsed.next ?? 1,
          orders: parsed.orders ?? [],
          reports: parsed.reports ?? [],
        }
      } catch {
        // A broken file: start with an empty book rather than crash.
      }
    }
  }

  get orders(): Order[] {
    return [...this.data.orders]
  }

  find(id: string): Order | undefined {
    return this.data.orders.find((o) => o.id === id)
  }

  add(order: Omit<Order, 'id' | 'at'>, at = Date.now()): Order {
    const added = { ...order, id: `O${this.data.next++}`, at }
    this.data.orders.push(added)
    while (this.data.orders.length > this.max) this.data.orders.shift()
    this.save()
    return added
  }

  /** Remove orders by id or by test; returns what was removed. */
  remove(which: string[] | ((o: Order) => boolean)): Order[] {
    const test = Array.isArray(which) ? (o: Order) => which.includes(o.id) : which
    const gone = this.data.orders.filter(test)
    if (gone.length === 0) return []
    this.data.orders = this.data.orders.filter((o) => !gone.includes(o))
    this.save()
    return gone
  }

  /** The order that keeps the body busy, if any (the newest). */
  post(): Order | undefined {
    return [...this.data.orders].reverse().find((o) => o.post)
  }

  addReport(text: string): void {
    this.data.reports.push(text)
    this.save()
  }

  get reports(): string[] {
    return [...this.data.reports]
  }

  /** The reports were given: forget them. */
  reported(): void {
    if (this.data.reports.length === 0) return
    this.data.reports = []
    this.save()
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}

/** The rules the royal family laid down for the whole court. File-backed, shared by all bots. */
export class CourtRules {
  private data: { next: number; rules: Rule[] } = { next: 1, rules: [] }

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          next?: number
          rules?: Rule[]
        }
        this.data = { next: parsed.next ?? 1, rules: parsed.rules ?? [] }
      } catch {
        // A broken file: no rules rather than a crash.
      }
    }
  }

  get rules(): Rule[] {
    return [...this.data.rules]
  }

  find(id: string): Rule | undefined {
    return this.data.rules.find((r) => r.id === id)
  }

  add(rule: Omit<Rule, 'id' | 'at'>, at = Date.now()): Rule {
    const added = { ...rule, id: `R${this.data.next++}`, at }
    this.data.rules.push(added)
    this.save()
    return added
  }

  remove(ids: string[]): Rule[] {
    const gone = this.data.rules.filter((r) => ids.includes(r.id))
    if (gone.length === 0) return []
    this.data.rules = this.data.rules.filter((r) => !gone.includes(r))
    this.save()
    return gone
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}

/** How the model read a royal's line. */
/** What a magic-working bot's reader needs to know: its spells, the places, how spells are built. */
export interface MagicInfo {
  spells: Array<{ id: string; does: string; needs: string[] }>
  places: string[]
  guide: string[]
}

/** A request for a spell, as the model read it. */
export interface SpellRequest {
  id: string
  target?: string
  place?: string
  item?: string
  /** How many of the item were asked for. */
  count?: number
  creature?: string
  effect?: string
}

export interface Reading {
  type: 'order' | 'rule' | 'release' | 'teach' | 'none'
  /** The order or release is meant for this bot (alone, with others, or the whole court). */
  forMe: boolean
  /** The order or rule as one short instruction. */
  summary: string
  /** Stands until ended (following, staying, always doing something), not a one-off task. */
  lasting: boolean
  /** Ids of laws, rules and standing orders it cannot be kept together with. */
  clashes: string[]
  /** For a release: the ids of the standing orders it ends. */
  releases: string[]
  /** For a request for magic: which spells, in order, on whom, and what each needs. */
  spells?: SpellRequest[]
  /** For a spell the King teaches: its name, what it does, and its steps. */
  teach?: { name: string; does: string; steps: unknown[] }
}

/** The reading schema; with magic, also a spell request and a spell being taught. */
export function readingSchema(magic?: MagicInfo): object {
  if (!magic) return READING_SCHEMA
  const text = { type: 'string' }
  const num = { type: 'number' }
  return {
    ...READING_SCHEMA,
    properties: {
      ...READING_SCHEMA.properties,
      type: { type: 'string', enum: ['order', 'rule', 'release', 'teach', 'none'] },
      spells: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: [...magic.spells.map((s) => s.id), 'unknown'] },
            target: text,
            place: text,
            item: text,
            count: { type: 'integer', minimum: 1, maximum: 64 },
            creature: text,
            effect: text,
          },
          required: ['id'],
        },
      },
      teach: {
        type: 'object',
        properties: {
          name: text,
          does: text,
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: [
                    'teleport',
                    'effect',
                    'weather',
                    'time',
                    'summon',
                    'particle',
                    'sound',
                    'give',
                    'saddle',
                  ],
                },
                who: text,
                to: text,
                at: text,
                effect: text,
                seconds: num,
                amplifier: num,
                weather: text,
                time: text,
                creature: text,
                count: num,
                particle: text,
                sound: text,
                item: text,
              },
              required: ['kind'],
            },
          },
        },
        required: ['name', 'does', 'steps'],
      },
    },
  }
}

export const READING_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['order', 'rule', 'release', 'none'] },
    forMe: { type: 'boolean' },
    summary: { type: 'string' },
    lasting: { type: 'boolean' },
    clashes: { type: 'array', items: { type: 'string' } },
    releases: { type: 'array', items: { type: 'string' } },
  },
  required: ['type', 'forMe', 'summary', 'lasting', 'clashes', 'releases'],
}

export function readingPrompt(bot: string, role: string, magic?: MagicInfo): string {
  const lines = [
    `You help ${bot}, the ${role} of a royal court on a family Minecraft server, keep track of orders.`,
    'Read the newest line, said by a member of the royal family, and decide what it is:',
    `- "order": it tells ${bot}, a group ${bot} belongs to, or the whole court what to do, where to be`,
    '  or how to behave.',
    '- "rule": it lays down a lasting rule for the whole court ("from now on ...", "nobody may ...",',
    '  "everyone must always ...").',
    `- "release": it ends one of ${bot}'s standing orders ("you may stop guarding", "you are free to`,
    '  go", "stop following me", "back to work").',
    '- "none": anything else: chat, questions, wishes, stories, games, or asking for a riddle, a joke',
    '  or a story.',
    `forMe: true when the order or release is meant for ${bot} (alone, with others, or the whole`,
    '  court); false when it is meant only for someone else.',
    'summary: the order or rule as one short instruction, e.g. "Stay by the castle gate." or',
    '  "Nobody may enter the Princess\'s bedchamber."',
    'lasting: true when it stays in force until it is ended (following someone, staying somewhere,',
    '  always doing something); false for a one-off task (come here, build a tower, look at this).',
    'clashes: the ids of the laws, rules and standing orders that cannot be kept together with it.',
    '  Only real contradictions: "stay by the gate" and "follow the Princess" clash; "be polite" and',
    '  "stay by the gate" do not. A new order that only repeats a standing one does not clash.',
    'releases: for a release, the ids of the standing orders it ends; otherwise empty.',
  ]
  if (magic) {
    lines.push(
      `${bot} works magic. A request for one or more of these spells is an "order" that is not`,
      'lasting, with "spells" listing each spell to cast in the order asked (at most three). To',
      'send two people somewhere, list the spell once for each of them:',
      ...magic.spells.map(
        (s) => `- ${s.id}: ${s.does}${s.needs.length ? ` [needs: ${s.needs.join(', ')}]` : ''}`
      ),
      'target: whom the spell is cast on: "speaker" for the one speaking (also when nobody else is',
      `  named), "${bot}" for ${bot} himself, otherwise the name or title of the one named, such as`,
      '  "the King" or "Bruce".',
      `place, for a spell that needs one, exactly as written here: ${magic.places.join('; ')}.`,
      'item, creature, effect: for a spell that needs them, as its line lists.',
      'count: for a gift or creatures, how many were asked for; leave it out when no number was said.',
      'A request for magic that none of these spells can do is an "order" with one spell of id',
      '"unknown".',
      `The King may teach ${bot} a new spell by describing it. Then the type is "teach", and`,
      '"teach" holds its name, what it does, and its steps, built only from these kinds:',
      ...magic.guide
    )
  }
  return lines.join('\n')
}

export function readingInput(opts: {
  rules: Rule[]
  orders: Order[]
  earlier: string
  speaker: string
  line: string
}): string {
  const laws = COURT_LAWS.map((l, i) => `L${i + 1}. ${l}`)
  const rules = opts.rules.map((r) => `${r.id}. ${r.text} (laid down by ${r.by})`)
  const orders = opts.orders.map((o) => `${o.id}. ${o.text} (ordered by ${o.by})`)
  return [
    `Laws of the court:\n${laws.join('\n')}`,
    `Rules of the court:\n${rules.join('\n') || '(none)'}`,
    `Standing orders:\n${orders.join('\n') || '(none)'}`,
    `Earlier lines:\n${opts.earlier || '(none)'}`,
    `Newest line, from ${opts.speaker}:\n${opts.line}`,
  ].join('\n\n')
}

const YES =
  /^(yes|yeah|yep|aye|indeed|sure|i'?m sure|i am sure|do it|go ahead|confirm(ed)?|correct|that'?s right|please do|of course|do as i say|no problem|no worries)\b/
const NO = /^(no|nope|nah|never ?mind|cancel|don'?t|forget it|keep|leave it)\b/

/** The King's answer to "shall I do it anyway?": "Yes", "Bruce, yes", "no, leave it". */
export function confirmation(message: string): 'yes' | 'no' | undefined {
  const words = message
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .trim()
  // At the start, or just after the name of the one addressed.
  for (const start of [words, words.replace(/^\S+\s*/, '')]) {
    if (YES.test(start)) return 'yes'
    if (NO.test(start)) return 'no'
  }
  return undefined
}
