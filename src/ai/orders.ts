import {
  deleteOrders,
  deleteReports,
  deleteRules,
  insertOrder,
  insertReport,
  insertRule,
  loadBook,
  loadRules,
} from '../db/court'
import { FileKeeper, inDatabase, type InDatabase, type Keeper } from '../db/shared'

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

export interface BookData {
  next: number
  orders: Order[]
  /** What this bot still has to tell its superior (orders it took straight from a royal). */
  reports: string[]
}

/** Orders and rules files are looked at this often for changes made elsewhere. */
const RELOAD_MS = 2_000

export function parseBook(raw: unknown): BookData {
  const parsed = (raw ?? {}) as Partial<BookData>
  return { next: parsed.next ?? 1, orders: parsed.orders ?? [], reports: parsed.reports ?? [] }
}

export function parseRules(raw: unknown): { next: number; rules: Rule[] } {
  const parsed = (raw ?? {}) as { next?: number; rules?: Rule[] }
  return { next: parsed.next ?? 1, rules: parsed.rules ?? [] }
}

/**
 * One bot's standing orders and the reports it owes its superior. Kept in the database or a
 * file, and read again when changed elsewhere: by the court of the other world (Merlin is in
 * both), or the admin (src/admin), which can release an order.
 */
export class OrderBook {
  private readonly keeper: Keeper<BookData>
  private readonly bot: string

  constructor(
    where?: string | InDatabase,
    private readonly max = 12
  ) {
    if (inDatabase(where)) {
      const bot = (this.bot = (where.bot ?? '').toLowerCase())
      this.keeper = where.shared.replica(
        `orders:${bot}`,
        (q) => loadBook(q, bot),
        () => ({ next: 1, orders: [], reports: [] })
      )
    } else {
      this.bot = ''
      this.keeper = new FileKeeper(where, parseBook, () => ({ next: 1, orders: [], reports: [] }), {
        checkMs: RELOAD_MS,
      })
    }
  }

  get orders(): Order[] {
    return [...this.keeper.read().orders]
  }

  find(id: string): Order | undefined {
    return this.keeper.read().orders.find((o) => o.id === id)
  }

  add(order: Omit<Order, 'id' | 'at'>, at = Date.now()): Order {
    let added!: Order
    this.keeper.update(
      (book) => {
        added = { ...order, id: `O${book.next++}`, at }
        book.orders.push(added)
        while (book.orders.length > this.max) book.orders.shift()
      },
      (tx) => insertOrder(tx, this.bot, added, this.max)
    )
    return added
  }

  /** Remove orders by id or by test; returns what was removed. */
  remove(which: string[] | ((o: Order) => boolean)): Order[] {
    const test = Array.isArray(which) ? (o: Order) => which.includes(o.id) : which
    let gone: Order[] = []
    this.keeper.update(
      (book) => {
        gone = book.orders.filter(test)
        if (gone.length === 0) return false
        book.orders = book.orders.filter((o) => !gone.includes(o))
      },
      (tx) =>
        deleteOrders(
          tx,
          this.bot,
          gone.map((o) => o.id)
        )
    )
    return gone
  }

  /** The order that keeps the body busy, if any (the newest). */
  post(): Order | undefined {
    return [...this.keeper.read().orders].reverse().find((o) => o.post)
  }

  addReport(text: string): void {
    const at = Date.now()
    this.keeper.update(
      (book) => {
        book.reports.push(text)
      },
      (tx) => insertReport(tx, this.bot, text, at)
    )
  }

  get reports(): string[] {
    return [...this.keeper.read().reports]
  }

  /** The reports were given: forget them. */
  reported(): void {
    let given: string[] = []
    this.keeper.update(
      (book) => {
        given = book.reports
        if (given.length === 0) return false
        book.reports = []
      },
      (tx) => deleteReports(tx, this.bot, given)
    )
  }
}

/**
 * The rules the royal family laid down for the whole court, shared by all bots of both worlds.
 * Kept in the database or a file.
 */
export class CourtRules {
  private readonly keeper: Keeper<{ next: number; rules: Rule[] }>

  constructor(where?: string | InDatabase) {
    this.keeper = inDatabase(where)
      ? where.shared.replica('rules', loadRules, () => ({ next: 1, rules: [] }))
      : new FileKeeper(where, parseRules, () => ({ next: 1, rules: [] }), { checkMs: RELOAD_MS })
  }

  get rules(): Rule[] {
    return [...this.keeper.read().rules]
  }

  find(id: string): Rule | undefined {
    return this.keeper.read().rules.find((r) => r.id === id)
  }

  add(rule: Omit<Rule, 'id' | 'at'>, at = Date.now()): Rule {
    let added!: Rule
    this.keeper.update(
      (data) => {
        added = { ...rule, id: `R${data.next++}`, at }
        data.rules.push(added)
      },
      (tx) => insertRule(tx, added)
    )
    return added
  }

  remove(ids: string[]): Rule[] {
    let gone: Rule[] = []
    this.keeper.update(
      (data) => {
        gone = data.rules.filter((r) => ids.includes(r.id))
        if (gone.length === 0) return false
        data.rules = data.rules.filter((r) => !gone.includes(r))
      },
      (tx) =>
        deleteRules(
          tx,
          gone.map((r) => r.id)
        )
    )
    return gone
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
