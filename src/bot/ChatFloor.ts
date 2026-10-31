import fs from 'node:fs'
import path from 'node:path'
import type { ChatEvent } from '../ai/Brain'
import { mentionsNameLoosely } from '../ai/text'

/** A bot keeps the conversation with a player for this long after its last reply to them. */
const PARTNER_MS = 3 * 60_000
/**
 * Chat lines arriving at the bots within this window are the same line. Over Nethernet one line
 * reaches the six bots up to three seconds apart; a shorter window let a second bot answer it.
 */
const SAME_LINE_MS = 10_000

/**
 * Decides which bot speaks, so a court of several bots answers a line once, not in chorus.
 * Every bot receives every chat line separately; the first to ask decides for all.
 *
 *   0. A line `route` gives to a bot goes to it ("GMH" from the King: Merlin).
 *   1. A bot named in the line answers (the first one named, spelling forgiven).
 *   2. Otherwise the bot already talking with that player answers.
 *   3. Otherwise the herald answers: the first online bot in court order.
 *
 * The herald alone hails arrivals and reacts to server notices.
 */
export class ChatFloor {
  private readonly online = new Set<string>()
  private readonly partners: PartnerStore
  private readonly decisions = new Map<string, { bot: string | null; at: number }>()
  /** The other mind's bots (the army's, for the household): their lines are not ours. */
  private readonly foreign: Set<string>
  /** Does this mind have the herald (hails, notices, lines for nobody in particular)? */
  private readonly heraldHere: boolean

  /**
   * @param order bot names in court order: who speaks first for the royal family
   * @param guestOrder who speaks first for everyone else (defaults to `order`)
   * @param route the bot a line belongs to whoever else is named or talking, if any
   * @param minds with the court in two minds (processes): the other's bots, whether the herald is
   *   here, and the partners both share
   */
  constructor(
    private readonly order: string[],
    private readonly guestOrder: string[] = order,
    private readonly route?: (event: ChatEvent) => string | undefined,
    minds: { foreign?: string[]; herald?: boolean; partners?: PartnerStore } = {}
  ) {
    this.foreign = new Set(minds.foreign ?? [])
    this.heraldHere = minds.herald ?? true
    this.partners = minds.partners ?? new MemoryPartners()
  }

  setOnline(bot: string, online: boolean): void {
    if (online) this.online.add(bot)
    else this.online.delete(bot)
  }

  /** The bot that speaks for the court: the first online in court order (guest order for guests). */
  herald(forGuest = false): string | null {
    if (!this.heraldHere) return null
    return (forGuest ? this.guestOrder : this.order).find((b) => this.online.has(b)) ?? null
  }

  isHerald(bot: string, forGuest = false): boolean {
    return this.herald(forGuest) === bot
  }

  /** The bot that should answer this chat line (null: nobody in particular). */
  responder(event: ChatEvent, fromGuest = false): string | null {
    const key = `${event.from.toLowerCase()}|${event.message}`
    const now = Date.now()
    const cached = this.decisions.get(key)
    if (cached && now - cached.at < SAME_LINE_MS) return cached.bot
    for (const [k, d] of this.decisions) if (now - d.at > SAME_LINE_MS) this.decisions.delete(k)

    const bot = this.decide(event, now, fromGuest)
    this.decisions.set(key, { bot, at: now })
    return bot
  }

  /** Record that a bot replied to a player, so the conversation stays with it. */
  replied(bot: string, player: string): void {
    this.partners.set(player.toLowerCase(), bot, Date.now())
  }

  private decide(event: ChatEvent, now: number, fromGuest: boolean): string | null {
    const routed = this.route?.(event)
    if (routed && this.online.has(routed)) return routed
    if (routed && this.foreign.has(routed)) return null
    // The first named, of this mind or the other's (whose own floor gives it the line).
    const named = [...this.order, ...this.foreign]
      .filter(
        (b) => (this.online.has(b) || this.foreign.has(b)) && mentionsNameLoosely(event.message, b)
      )
      .map((b) => ({ b, at: firstMention(event.message, b) }))
      .sort((x, y) => x.at - y.at)
    if (named.length) return this.foreign.has(named[0].b) ? null : named[0].b
    const partner = this.partners.get(event.from.toLowerCase())
    if (partner && now - partner.at < PARTNER_MS) {
      if (this.foreign.has(partner.bot)) return null
      if (this.online.has(partner.bot)) return partner.bot
    }
    return this.herald(fromGuest)
  }
}

/** Where a name is first mentioned (exactly, or else by its first three letters). */
function firstMention(message: string, name: string): number {
  const lower = message.toLowerCase()
  const exact = lower.indexOf(name.toLowerCase())
  if (exact >= 0) return exact
  const prefix = lower.indexOf(name.slice(0, 3).toLowerCase())
  return prefix >= 0 ? prefix : Number.MAX_SAFE_INTEGER
}

/** Who each player last talked with, and when. */
export interface PartnerStore {
  get(player: string): { bot: string; at: number } | undefined
  set(player: string, bot: string, at: number): void
}

class MemoryPartners implements PartnerStore {
  private readonly map = new Map<string, { bot: string; at: number }>()
  get(player: string) {
    return this.map.get(player)
  }
  set(player: string, bot: string, at: number) {
    this.map.set(player, { bot, at })
  }
}

/** Partners in a file, for the two minds of one world: a royal talking with Bruce stays with him. */
export class FilePartners implements PartnerStore {
  private data: Record<string, { bot: string; at: number }> = {}
  private mtime = 0

  constructor(private readonly file: string) {}

  get(player: string) {
    this.read()
    return this.data[player]
  }

  set(player: string, bot: string, at: number) {
    this.read()
    this.data[player] = { bot, at }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data))
      fs.renameSync(tmp, this.file)
      this.mtime = fs.statSync(this.file).mtimeMs
    } catch {
      // Best effort: at worst the herald answers a line the other mind's bot was asked.
    }
  }

  private read() {
    try {
      const mtime = fs.statSync(this.file).mtimeMs
      if (mtime === this.mtime) return
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as typeof this.data
      this.mtime = mtime
    } catch {
      // None yet.
    }
  }
}
