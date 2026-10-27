import type { ChatEvent } from '../ai/Brain'
import { mentionsNameLoosely } from '../ai/text'

/** A bot keeps the conversation with a player for this long after its last reply to them. */
const PARTNER_MS = 3 * 60_000
/** Chat lines arriving at the bots within this window are the same line. */
const SAME_LINE_MS = 3_000

/**
 * Decides which bot speaks, so a court of several bots answers a line once, not in chorus.
 * Every bot receives every chat line separately; the first to ask decides for all.
 *
 *   1. A bot named in the line answers (the first one named, spelling forgiven).
 *   2. Otherwise the bot already talking with that player answers.
 *   3. Otherwise the herald answers: the first online bot in court order.
 *
 * The herald alone hails arrivals and reacts to server notices.
 */
export class ChatFloor {
  private readonly online = new Set<string>()
  private readonly partners = new Map<string, { bot: string; at: number }>()
  private readonly decisions = new Map<string, { bot: string | null; at: number }>()

  /**
   * @param order bot names in court order: who speaks first for the royal family
   * @param guestOrder who speaks first for everyone else (defaults to `order`)
   */
  constructor(
    private readonly order: string[],
    private readonly guestOrder: string[] = order
  ) {}

  setOnline(bot: string, online: boolean): void {
    if (online) this.online.add(bot)
    else this.online.delete(bot)
  }

  /** The bot that speaks for the court: the first online in court order (guest order for guests). */
  herald(forGuest = false): string | null {
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
    this.partners.set(player.toLowerCase(), { bot, at: Date.now() })
  }

  private decide(event: ChatEvent, now: number, fromGuest: boolean): string | null {
    const named = this.order
      .filter((b) => this.online.has(b) && mentionsNameLoosely(event.message, b))
      .map((b) => ({ b, at: firstMention(event.message, b) }))
      .sort((x, y) => x.at - y.at)
    if (named.length) return named[0].b
    const partner = this.partners.get(event.from.toLowerCase())
    if (partner && now - partner.at < PARTNER_MS && this.online.has(partner.bot)) return partner.bot
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
