import type { BotConfig } from '../config'
import type { CourtMember, CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { makeBlueprint, spellbookList, type Palette } from '../build/blueprints'
import { choosePalette } from '../build/palette'
import { describeCommission, type CommissionBook } from '../build/Commissions'
import type {
  BotAction,
  Brain,
  BrainContext,
  BrainReply,
  BuildOutcome,
  ChatEvent,
  SeenPlayer,
} from './Brain'
import { byHand } from './Brain'
import {
  abilityNote,
  declineLine,
  detectBuildRequest,
  detectMissingAbility,
  detectMoveCommand,
  detectUndoRequest,
  detectWorksRequest,
  promisesAction,
  type MissingAbility,
  type WorksRequest,
} from './abilities'
import { CourtMemory, recall } from './CourtMemory'
import {
  COURT_LAWS,
  CourtRules,
  OrderBook,
  confirmation,
  judge,
  rankOf,
  readingInput,
  readingPrompt,
  readingSchema,
  type Clash,
  type MagicInfo,
  type Order,
  type Post,
  type Reading,
} from './orders'
import type { Magic } from '../magic/Magic'
import {
  ITEMS_PER_HOUR,
  needs,
  stepGuide,
  tidySteps,
  type SpellArgs,
  type Step,
} from '../magic/spells'
import { guessedRiddle, pickRiddle, wantsRiddle, type Riddle } from './riddles'
import { HailLog } from './HailLog'
import type { ChatMessage, ChatModel } from './OllamaClient'
import { SILENT_TOKEN, cleanChatReply, mentionsName, mentionsNameLoosely } from './text'

/** Do not hail the same player again if they rejoin within this window. */
export const REHAIL_AFTER_MS = 10 * 60_000

/** A royal's answer not ready after this long: the bot thinks aloud first. */
const THINKING_MS = 2_500
/** At most one "let me think" a minute, so a long talk is not full of them. */
const THINKING_GAP_MS = 60_000
const THINKING_LINES = [
  'Hmm, let me see...',
  'Well now, let me think...',
  'Oh, let me think about that...',
  'Mhm... one moment...',
  'Hmm... well...',
]

/** An unanswered riddle is forgotten after this long. */
const RIDDLE_EXPIRES_MS = 15 * 60_000

/** The player gives up on a riddle ("I don't know" alone is not giving up: give a hint instead). */
const GIVE_UP = /\b(give up|tell me( the)? answer|what('?s| is) the answer|just tell me)\b/i

/** Remembered facts per subject in the prompt: the most recent, plus older ones the talk is about. */
const FACTS_IN_PROMPT = {
  royal: { recent: 25, relevant: 10 },
  self: { recent: 10, relevant: 5 },
  fellow: { recent: 3, relevant: 2 },
}

/** The King has this long to answer "shall I do it anyway?". */
const CONFIRM_MS = 5 * 60_000

/** A line meant for the whole court, or a group in it: every bot that hears it reads it for orders. */
const CALLS_ALL =
  /\b(every(one|body)|all of you|you all|y'?all|guards|apprentices|the court|whole court|staff)\b/i

/** "Stay here", "wait there", "don't move", "guard this door": keep to this spot. */
const STAY =
  /\b((stay|wait|remain|stand)( right)? (here|there|put|where you are)|don'?t move|hold (your )?position|keep watch here|guard (this|that) (spot|place|door|gate|entrance))\b/i

/** The scribe writes a royal conversation down once it has been quiet this long... */
const LEARN_QUIET_MS = 15_000
/** ...or has gone on this long. */
const LEARN_AFTER_MS = 90_000

/** React to the same kind of notice about the same person at most this often. */
const NOTICE_COOLDOWN_MS = 2 * 60_000

type NoticeKind = 'death' | 'sleep' | 'achievement'

/** Which server notices about a royal deserve a reaction. */
function noticeKind(key: string): NoticeKind | null {
  if (key.startsWith('death.')) return 'death'
  if (key === 'chat.type.sleeping') return 'sleep'
  if (key.startsWith('chat.type.achievement')) return 'achievement'
  return null
}

/** Always part of the system prompt; not configurable. The princess is a child. */
const SAFETY_RULES = [
  'Safety rules, always:',
  '- Keep everything kind, cheerful and suitable for a young child: no scary, violent or grown-up topics and no rude words.',
  '- Never ask anyone for personal information such as real names, ages, addresses, schools or passwords, and never repeat such things to guests. What the royal family tells you about their real life is private, for them alone.',
  '- Never suggest meeting, messaging or talking outside the game.',
].join('\n')

/**
 * Chat brain backed by Ollama. Knows the royal court, hails royals when they arrive, remembers
 * recent chat, decides whether a line deserves a reply, and runs one inference at a time.
 */
export class OllamaBrain implements Brain {
  private readonly history: ChatMessage[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private lastReplyAt = 0
  private readonly noticeCooldowns = new Map<string, number>()
  private readonly hails: HailLog
  /** What this bot remembers: only what it heard itself. */
  private readonly memory: CourtMemory
  private readonly staff: StaffMember[]
  private learning: Promise<void> = Promise.resolve()
  /** Notes of the royal conversation going on that this bot hears, not yet written down. */
  private heard: { lines: string[]; royals: Map<string, CourtMember>; since: number } | undefined
  private learnTimer?: NodeJS.Timeout
  /** The last lines written down: context for the next extraction. */
  private lastHeard: string[] = []
  /** The riddle the bot asked and is waiting for an answer to. */
  private activeRiddle?: { riddle: Riddle; askedAt: number }
  /** Set when this turn solves or gives up the active riddle; cleared after the reply. */
  private riddleDone = false
  private readonly toldRiddles = new Set<string>()
  private lastThinking = 0
  private lastThinkingLine?: string
  /** This bot's standing orders, and what it owes its superior. */
  private readonly orders: OrderBook
  /** The rules the royal family laid down for the whole court. */
  private readonly rules: CourtRules
  /** Merlin's magic; undefined for bots that work none. */
  private readonly magic?: Magic
  /** The builds the royal family asked for (shared by the court). */
  private readonly commissions?: CommissionBook
  /** An order or rule from the King that clashes with others, waiting for "yes" or "no". */
  private pendingOrder?: {
    member: CourtMember
    reading: Reading
    turn: Turn
    clashes: string[]
    message: string
    at: number
  }

  constructor(
    private readonly cfg: BotConfig,
    private readonly ai: ChatModel,
    private readonly court: CourtRoster,
    private readonly log: Logger,
    opts: BrainOptions = {}
  ) {
    this.hails = opts.hails ?? new HailLog()
    this.memory = opts.memory ?? new CourtMemory()
    this.staff = (opts.staff ?? []).filter((s) => s.name !== cfg.name)
    this.orders = opts.orders ?? new OrderBook()
    this.rules = opts.rules ?? new CourtRules()
    this.magic = opts.magic
    this.commissions = opts.commissions
  }

  /** Writes down what was heard now and resolves once every extraction has finished (for tests). */
  settled(): Promise<void> {
    this.writeDown()
    return this.learning
  }

  /** A fellow bot spoke: if this bot heard it, it belongs with the royal conversation going on. */
  onCourtLine(event: ChatEvent, ctx: BrainContext): void {
    const court = [this.cfg.name, ...this.staff.map((s) => s.name)].map((n) => n.toLowerCase())
    if (ctx.hears === false || !court.includes(event.from.toLowerCase())) return
    // A courtier talking to this bot (a report, say) is worth remembering even without a royal.
    const toMe = mentionsName(event.message, ctx.botName)
    this.hear(`${event.from}: ${event.message}`, undefined, toMe)
  }

  onPlayerLeave(player: string): void {
    const lower = player.toLowerCase()
    // Following someone ends when they leave the realm.
    this.orders.remove((o) => o.post?.type === 'follow' && o.post.target.toLowerCase() === lower)
  }

  post(): Post | undefined {
    return this.orders.post()?.post
  }

  pendingReports(): string[] {
    return this.orders.reports
  }

  reported(): void {
    this.orders.reported()
  }

  async onSpawn(ctx: BrainContext): Promise<string | null> {
    const royals = ctx.players
      .map((p) => this.court.find(p.name))
      .filter((m): m is CourtMember => m !== undefined)
    if (royals.length === 0) return this.cfg.chat.greeting ?? null

    // Royals hailed moments ago (the bot only restarted) are not hailed again.
    const fresh = royals.filter((m) => !this.hails.recent(m.player, REHAIL_AFTER_MS))
    for (const m of royals) this.hails.set(m.player)
    const titles = (members: CourtMember[]) => members.map((m) => `the ${m.title}`).join(' and ')
    const be = (members: CourtMember[]) => (members.length > 1 ? 'are' : 'is')

    if (fresh.length === 0) {
      return this.generate(ctx, {
        eventPrompt:
          `[event] You vanished for a moment and have just reappeared; ${titles(royals)} ` +
          `${be(royals)} here. Say in one short sentence that you are back.`,
        fallback: `I have returned, ${royals.map((m) => m.address).join(' and ')}.`,
      })
    }
    return this.generate(ctx, {
      eventPrompt:
        `[event] You have just arrived and ${titles(fresh)} ${be(fresh)} here. ` +
        `Greet ${titles(fresh)} as befits the royal rank, in one or two short sentences.`,
      fallback: fallbackHail(fresh),
    })
  }

  async onPlayerJoin(player: string, ctx: BrainContext): Promise<string | null> {
    const member = this.court.find(player)
    if (!member && !this.cfg.chat.greetVisitors) {
      this.remember({ role: 'user', content: `[event] ${player}, a guest, joined the game.` })
      return null
    }
    if (this.hails.recent(player, REHAIL_AFTER_MS)) {
      this.log.debug(`not hailing ${player} again so soon`)
      return null
    }
    this.hails.set(player)

    if (member) {
      return this.generate(ctx, {
        eventPrompt:
          `[event] The ${member.title} has just entered the realm. Hail the ${member.title} ` +
          'as befits the royal rank, in one or two short sentences.',
        fallback: fallbackHail([member]),
      })
    }
    return this.generate(ctx, {
      eventPrompt: `[event] ${player}, a guest, has just entered the realm. Welcome them briefly and kindly.`,
    })
  }

  async onChat(event: ChatEvent, ctx: BrainContext): Promise<BrainReply | null> {
    const member = this.court.find(event.from)
    this.remember({ role: 'user', content: `${this.court.label(event.from)}: ${event.message}` })

    // Remember what this bot hears, whoever answers it.
    if (ctx.hears !== false) {
      const whispered = event.kind === 'whisper' ? `(whispered to ${ctx.botName} alone) ` : ''
      this.hear(`${whispered}${this.court.label(event.from)}: ${event.message}`, member)
    }
    // Royal orders are read by the bot that answers, by every bot named, and by everyone who
    // hears a call to the whole court.
    const reads =
      member !== undefined &&
      ctx.hears !== false &&
      (ctx.mayReply !== false ||
        mentionsNameLoosely(event.message, ctx.botName) ||
        CALLS_ALL.test(event.message))
    // Another bot of the court has the floor: listen, but stay quiet, unless an order for this
    // bot must be declined or queried.
    if (ctx.mayReply === false) {
      if (!reads) return null
      const quiet = await this.orderTurn(event, member, ctx, this.actionTurn(event, member, ctx))
      if (!quiet.speak) return quiet.action ? { say: null, action: quiet.action } : null
      const say = await this.generate(ctx, { note: quiet.note })
      if (say) this.hear(`${ctx.botName}: ${say}`)
      return quiet.action ? { say, action: quiet.action } : say ? { say } : null
    }
    if (!this.shouldReply(event, member)) return null
    // Royals always get an answer (queued); for everyone else a busy brain just skips.
    if (!member && this.pending > 0) {
      this.log.debug('skipping reply: inference already in flight')
      return null
    }
    const sinceLast = Date.now() - this.lastReplyAt
    if (!member && sinceLast < this.cfg.chat.cooldownMs) {
      this.log.debug(`skipping reply: cooldown (${this.cfg.chat.cooldownMs - sinceLast}ms left)`)
      return null
    }
    const speaker = member ? `The ${member.title}` : event.from
    // The line just before this one (already in history) was ours: they are answering us.
    const answeringUs = this.history.at(-2)?.role === 'assistant'
    // Reading the line and answering often takes a royal 4-6 s of waiting: when it takes a while
    // the bot says something at once, as a person would ("Hmm, let me see...").
    const thinking = member ? this.thinkAloud(ctx) : undefined
    let move: Turn
    let say: string | null
    try {
      const plain = this.actionTurn(event, member, ctx)
      const turn = reads && member ? await this.orderTurn(event, member, ctx, plain) : plain
      const missing = turn.ability ?? detectMissingAbility(event.message)
      // A wizard can travel by magic: only the spell decides what is possible then.
      const ability = turn.action || (this.magic && missing === 'travel') ? undefined : missing
      const riddleNote = this.riddleTurn(event.message)
      const notes = [
        turn.note,
        ability ? abilityNote(ability, ctx.botName) : '',
        riddleNote,
      ].filter(Boolean)
      move = turn
      say = await this.generate(ctx, {
        note: notes.join('\n') || undefined,
        ...(ability ? { ability, address: member?.address ?? 'my friend' } : {}),
        // A royal who names the bot (even misspelled) or answers it gets a reply, not silence.
        insist:
          member && (answeringUs || mentionsNameLoosely(event.message, ctx.botName))
            ? `(${speaker} is talking to you, ${ctx.botName}: answer kindly.)`
            : undefined,
      })
    } finally {
      clearTimeout(thinking)
    }
    if (this.riddleDone) {
      this.activeRiddle = undefined
      this.riddleDone = false
    }
    if (say) this.hear(`${ctx.botName}: ${say}`)
    if (!say && !move.action) return null
    return move.action ? { say, action: move.action } : { say }
  }

  /**
   * Say a short "let me think" line if the answer is not ready soon. It is not kept in the
   * history: the model answers as if it had only paused.
   */
  private thinkAloud(ctx: BrainContext): NodeJS.Timeout | undefined {
    const say = ctx.interim
    if (!say || Date.now() - this.lastThinking < THINKING_GAP_MS) return undefined
    return setTimeout(() => {
      this.lastThinking = Date.now()
      const lines = this.cfg.chat.thinking?.length ? this.cfg.chat.thinking : THINKING_LINES
      const fresh = lines.filter((l) => l !== this.lastThinkingLine)
      const line = fresh[Math.floor(Math.random() * fresh.length)] ?? lines[0]
      this.lastThinkingLine = line
      say(line)
    }, THINKING_MS)
  }

  /**
   * Note a line of a royal conversation this bot hears (a royal's own, or anyone's while a royal
   * is talking). It is written down once the talk pauses, so a whole exchange, with the answers
   * of whichever courtier gave them, goes to the memory model at once.
   */
  private hear(line: string, royal?: CourtMember, open = false): void {
    if (!royal && !open && !this.heard) return
    this.heard ??= { lines: [], royals: new Map(), since: Date.now() }
    this.heard.lines.push(line)
    if (royal) this.heard.royals.set(royal.player, royal)
    clearTimeout(this.learnTimer)
    const left = this.heard.since + LEARN_AFTER_MS - Date.now()
    this.learnTimer = setTimeout(
      () => this.writeDown(),
      Math.max(0, Math.min(LEARN_QUIET_MS, left))
    )
    this.learnTimer.unref?.()
  }

  /** Hand what was heard to the memory model, in the background, one conversation at a time. */
  private writeDown(): void {
    clearTimeout(this.learnTimer)
    const heard = this.heard
    this.heard = undefined
    if (!heard) return
    const earlier = this.lastHeard
    this.lastHeard = heard.lines.slice(-4)
    this.learning = this.learning
      .then(() => this.learn([...heard.royals.values()], heard.lines, earlier))
      .catch((err) => this.log.warn(`memory extraction failed: ${errMsg(err)}`))
  }

  /** What the line asks of the body. Building takes precedence over walking ("come and build"). */
  private actionTurn(event: ChatEvent, member: CourtMember | undefined, ctx: BrainContext): Turn {
    return this.buildTurn(event, member, ctx) ?? this.moveTurn(event, member, ctx)
  }

  /**
   * Royal orders. Reads the line for an order, a rule or a release, weighs it against the court's
   * laws and rules and this bot's standing orders (see `judge`), and keeps, declines or queries
   * it. Returns the turn with its action and note adjusted; `speak` when the bot must answer even
   * though another has the floor (to decline, or to ask the King).
   */
  private async orderTurn(
    event: ChatEvent,
    member: CourtMember,
    ctx: BrainContext,
    turn: Turn
  ): Promise<Turn & { speak?: boolean }> {
    const giver = `the ${member.title}`
    const rank = rankOf(member.role)
    const pending = this.pendingOrder
    if (pending && Date.now() - pending.at > CONFIRM_MS) this.pendingOrder = undefined
    if (this.pendingOrder && pending?.member.player === member.player) {
      const answer = confirmation(event.message)
      if (answer === 'no') {
        this.pendingOrder = undefined
        return {
          note: `(${giver} decided against it: everything stays as it was. Say so in one short sentence.)`,
          speak: true,
        }
      }
      if (answer === 'yes') {
        this.pendingOrder = undefined
        const kept = this.keep(
          pending.member,
          pending.reading,
          pending.turn,
          pending.clashes,
          pending.message
        )
        return { ...kept, note: join(`(${giver} confirmed it.)`, kept.note), speak: true }
      }
    }

    const reading = await this.read(event, member, ctx)
    if (!reading || reading.type === 'none') return turn
    if (reading.type === 'teach') return this.teachTurn(member, reading, turn, event.message)
    if (reading.type !== 'rule' && !reading.forMe) return turn

    if (reading.type === 'release') {
      const mine = reading.releases.filter((id) => this.orders.find(id))
      const above = mine.filter((id) => this.rankOfGiver(this.orders.find(id)?.from) > rank)
      if (above.length) {
        return {
          note: `(${giver} wants to end ${this.describe(above)}. That is not theirs to end: politely decline and explain whose order it is.)`,
          speak: true,
        }
      }
      const gone = this.orders.remove(mine)
      this.log.info(`released: ${gone.map((o) => o.text).join(' ') || 'nothing'}`)
      return gone.length
        ? {
            ...turn,
            note: join(turn.note, `(You are released from: ${gone.map((o) => o.text).join(' ')})`),
          }
        : turn
    }

    // A rule binds the whole court: the bot that answers the line keeps it, the others listen.
    if (reading.type === 'rule' && ctx.mayReply === false) return turn
    const clashes = this.clashesOf(reading.clashes)
    const verdict = judge(rank, this.topRank(), clashes)
    if (verdict.kind === 'decline') {
      const law = verdict.clashes.some((id) => id.startsWith('L'))
      return {
        note:
          `(${giver} asks: "${reading.summary}" But that clashes with ${this.describe(verdict.clashes)}. ` +
          (law
            ? 'Politely decline and explain that the laws of the court come before every order.)'
            : 'Politely decline and explain that the higher order comes first; do not do it.)'),
        speak: true,
      }
    }
    if (verdict.kind === 'confirm') {
      this.pendingOrder = {
        member,
        reading,
        turn,
        clashes: verdict.clashes,
        message: event.message,
        at: Date.now(),
      }
      return {
        note:
          `(${giver} asks: "${reading.summary}" But that clashes with ${this.describe(verdict.clashes)}. ` +
          `Do not do it yet: kindly point out the clash and ask ${giver} to confirm.)`,
        speak: true,
      }
    }
    return this.keep(member, reading, turn, verdict.replaces, event.message)
  }

  /** The King describes a new spell: check it, repeat it back, and learn it on "yes". */
  private teachTurn(
    member: CourtMember,
    reading: Reading,
    turn: Turn,
    message: string
  ): Turn & { speak?: boolean } {
    const magic = this.magic
    if (!magic) return turn
    const giver = `the ${member.title}`
    if (rankOf(member.role) < this.topRank()) {
      return {
        note: `(Only the King may teach you new magic. Say so kindly to ${giver}.)`,
        speak: true,
      }
    }
    const teach = reading.teach
    if (teach) teach.steps = tidySteps(teach.steps)
    const problems = teach?.name ? magic.problems(teach.steps) : ['no spell was described']
    if (!teach || problems.length) {
      return {
        note:
          `(${giver} wants to teach you a spell, but you cannot learn it as described: ` +
          `${problems.join('; ')}. Explain kindly what your magic can do, and ask again.)`,
        speak: true,
      }
    }
    this.pendingOrder = { member, reading, turn, clashes: [], message, at: Date.now() }
    return {
      note:
        `(${giver} teaches you a new spell, "${teach.name}": ${teach.does} Repeat in one or two ` +
        `short sentences what it will do, and ask ${giver} to confirm before you learn it.)`,
      speak: true,
    }
  }

  /** A royal asks for a spell: check whom it is for, what it needs and whether it is ready. */
  /**
   * A royal asks for one or more spells (cast in the order asked): check whom each is for, what
   * it needs and whether it is ready. Those that can be cast are; the note says what was cast and
   * why the others were not.
   */
  private spellTurn(member: CourtMember, reading: Reading): Turn {
    const magic = this.magic
    const requests = reading.spells ?? []
    if (!magic || requests.length === 0) return { note: '' }
    const giver = `the ${member.title}`
    if (magic.available === false) {
      return {
        note:
          `(Your magic is asleep: the realm has not granted you your wizard's powers since you ` +
          `last arrived. Tell ${giver} kindly, in character, that the King must renew them by ` +
          'speaking the words "op Merlin" at the heart of the server.)',
      }
    }
    const casts: Array<{ spell: string; args: SpellArgs; target: string }> = []
    const cast: string[] = []
    const refused: string[] = []
    for (const request of requests) {
      const spell = request.id === 'unknown' ? undefined : magic.find(request.id)
      if (!spell) {
        refused.push(
          `you know no such spell (you know: ${magic
            .spells()
            .map((s) => s.name)
            .join(', ')}; the King can teach you new ones)`
        )
        continue
      }
      const target = this.spellTarget(request.target, member)
      if (!target) {
        refused.push(
          `${spell.name}: you cannot tell on whom; you work magic only on the royal family and the court`
        )
        continue
      }
      const onTarget = spell.steps.some(
        (s) => ('who' in s && s.who === 'target') || ('at' in s && s.at === 'target')
      )
      if (onTarget && target !== member.player && this.rankOfGiver(target) > rankOf(member.role)) {
        refused.push(
          `${spell.name}: it is for someone who outranks ${giver}, and needs their own wish`
        )
        continue
      }
      const args: SpellArgs = {
        place: request.place,
        item: request.item,
        count: request.count,
        creature: request.creature,
        effect: request.effect,
      }
      const problem = magic.check(spell, args)
      if (problem) {
        refused.push(`${spell.name}: ${problem}`)
        continue
      }
      const wait = magic.wait(spell)
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60_000)
        refused.push(
          `${spell.name}: its magic is still gathering, ready again in ${minutes} minute${minutes > 1 ? 's' : ''}`
        )
        continue
      }
      casts.push({ spell: spell.id, args, target })
      const on =
        target === member.player
          ? giver
          : target === this.cfg.name
            ? 'yourself'
            : this.labelOf(target)
      cast.push(`${spell.name} on ${on}${args.place ? ` (to ${args.place})` : ''}: ${spell.does}`)
    }
    const notes = [
      cast.length
        ? `(You cast now, in this order: ${cast.join('; ')} Say so in one or two short, magical sentences, saying truly who goes where.)`
        : '',
      refused.length
        ? `(You cannot cast ${cast.length ? 'the rest' : 'it'}: ${refused.join('; ')}. Say so kindly, in character.)`
        : '',
    ]
    return {
      ...(casts.length
        ? { action: { type: 'cast' as const, casts, requestedBy: member.player } }
        : {}),
      note: join(...notes),
    }
  }

  /** "the King", or a courtier's name. */
  private labelOf(player: string): string {
    const member = this.court.find(player)
    return member ? `the ${member.title}` : player
  }

  /** Whom a spell is for: the speaker, a royal by title or name, or a courtier. Never a guest. */
  private spellTarget(name: string | undefined, member: CourtMember): string | undefined {
    const raw = (name ?? '').trim()
    if (!raw || /^(speaker|requester|me|myself|her|him|them|us)$/i.test(raw)) return member.player
    if (/^(you|yourself)$/i.test(raw)) return this.cfg.name
    const key = raw.replace(/^the /i, '').toLowerCase()
    const royal = this.court.members.find(
      (m) => m.title.toLowerCase() === key || m.player.toLowerCase() === key
    )
    if (royal) return royal.player
    return [this.cfg.name, ...this.staff.map((s) => s.name)].find((n) => n.toLowerCase() === key)
  }

  /** What the order reader needs to know about this bot's magic. */
  private magicInfo(): MagicInfo | undefined {
    const magic = this.magic
    if (!magic) return undefined
    return {
      spells: magic.spells().map((s) => ({ id: s.id, does: s.does, needs: needs(s) })),
      places: magic.places().map((p) => p.name),
      guide: stepGuide(),
    }
  }

  /** Take an order or rule: it replaces what it clashed with, and the body carries it out. */
  private keep(
    member: CourtMember,
    reading: Reading,
    turn: Turn,
    replaces: string[],
    message: string
  ): Turn {
    const giver = `the ${member.title}`
    if (reading.type === 'teach' && reading.teach && this.magic) {
      const spell = this.magic.learn(
        {
          name: reading.teach.name,
          does: reading.teach.does,
          steps: reading.teach.steps as Step[],
        },
        giver
      )
      this.log.info(`learned the spell ${spell.id} from ${giver}: ${JSON.stringify(spell.steps)}`)
      return {
        ...turn,
        note: `(You have learned the spell "${spell.name}". Say so proudly in one short sentence.)`,
      }
    }
    // A spell is cast at once, never kept as a standing order.
    if (reading.spells?.length && this.magic) return this.spellTurn(member, reading)
    const replaced = replaces.length ? `(It replaces ${this.describe(replaces)}.)` : ''
    this.orders.remove(replaces.filter((id) => id.startsWith('O')))
    if (reading.type === 'rule') {
      this.rules.remove(replaces.filter((id) => id.startsWith('R')))
      const rule = this.rules.add({ from: member.player, by: giver, text: reading.summary })
      this.log.info(`new rule ${rule.id} from ${giver}: ${rule.text}`)
      return {
        ...turn,
        note: join(
          turn.note,
          `(${giver} laid down a rule for the whole court: "${rule.text}" Acknowledge it in one short sentence.)`,
          replaced
        ),
      }
    }
    let action = turn.action
    if (!action && reading.lasting && (STAY.test(message) || STAY.test(reading.summary))) {
      action = { type: 'stay' }
    }
    if (action?.type === 'stop') this.orders.remove((o) => o.post !== undefined)
    const post: Post | undefined =
      action?.type === 'follow'
        ? { type: 'follow', target: action.target }
        : action?.type === 'stay'
          ? { type: 'stay' }
          : undefined
    if (reading.lasting || post) {
      // A new post replaces the old one: the body can only be in one place.
      if (post) this.orders.remove((o) => o.post !== undefined)
      const order = this.orders.add({ from: member.player, by: giver, text: reading.summary, post })
      this.log.info(`order ${order.id} from ${giver}: ${order.text}`)
    }
    if (this.cfg.reportsTo) this.orders.addReport(`${giver} gave me an order: ${reading.summary}`)
    const stays =
      action?.type === 'stay' && !turn.action
        ? '(You stay right here until you are released. Say so in one short sentence.)'
        : ''
    return { ...turn, action, note: join(turn.note, stays, replaced) }
  }

  /** Ask the model what a royal's line is: an order, a rule, a release, or none of these. */
  private async read(
    event: ChatEvent,
    member: CourtMember,
    ctx: BrainContext
  ): Promise<Reading | null> {
    const earlier = this.history
      .slice(-5, -1)
      .map((m) => (m.role === 'assistant' ? `${ctx.botName}: ${m.content}` : m.content))
      .join('\n')
    try {
      const model = this.cfg.ai.orderModel
      const response = await this.ai.chat(
        [
          { role: 'system', content: readingPrompt(ctx.botName, this.cfg.role, this.magicInfo()) },
          {
            role: 'user',
            content: readingInput({
              rules: this.rules.rules,
              orders: this.orders.orders,
              earlier,
              speaker: `the ${member.title}`,
              line: event.message,
            }),
          },
        ],
        {
          format: readingSchema(this.magicInfo()),
          temperature: 0,
          // A royal waits for the answer: if the big model is busy or cold, the chat model reads.
          ...(model ? { model, shared: true, timeoutMs: 15_000, priority: 'urgent' as const } : {}),
        }
      )
      const reading = JSON.parse(response.message.content || '{}') as Reading
      if (!reading.type) return null
      const known = (id: string) =>
        /^L\d+$/.test(id)
          ? Number(id.slice(1)) <= COURT_LAWS.length
          : Boolean(this.orders.find(id) ?? this.rules.find(id))
      reading.clashes = (reading.clashes ?? []).filter(known)
      reading.releases = (reading.releases ?? []).filter(known)
      reading.spells = (reading.spells ?? []).filter((r) => typeof r?.id === 'string').slice(0, 3)
      this.log.debug(`reading: ${JSON.stringify(reading)}`)
      return reading
    } catch (err) {
      this.log.warn(`could not read the line for orders: ${errMsg(err)}`)
      return null
    }
  }

  /** The laws, rules and orders behind clash ids, with who gave them. */
  private clashesOf(ids: string[]): Clash[] {
    return ids.map((id) => {
      if (id.startsWith('L')) return { id, rank: Infinity, law: true }
      const source = this.orders.find(id) ?? this.rules.find(id)
      return { id, rank: this.rankOfGiver(source?.from) }
    })
  }

  private describe(ids: string[]): string {
    return listWords(
      ids.map((id) => {
        if (id.startsWith('L'))
          return `the law of the court "${COURT_LAWS[Number(id.slice(1)) - 1]}"`
        const order = this.orders.find(id)
        if (order) return `your standing order from ${order.by}: "${order.text}"`
        const rule = this.rules.find(id)
        return rule ? `the rule ${rule.by} laid down: "${rule.text}"` : id
      })
    )
  }

  private rankOfGiver(from: string | undefined): number {
    return from ? rankOf(this.court.find(from)?.role) : 0
  }

  /** The highest royal rank at court (the King's). */
  private topRank(): number {
    return Math.max(1, ...this.court.members.map((m) => rankOf(m.role)))
  }

  /** The laws, the court's rules and this bot's standing orders, for the system prompt. */
  private ordersSection(): string {
    const lines = ['Laws of the court, above every order:', ...COURT_LAWS.map((l) => `- ${l}`)]
    const rules = this.rules.rules
    if (rules.length) {
      lines.push(
        'Rules the royal family laid down for the whole court:',
        ...rules.map((r) => `- ${r.text} (${r.by})`)
      )
    }
    const orders: Order[] = this.orders.orders
    if (orders.length) {
      lines.push('Your standing orders:', ...orders.map((o) => `- ${o.text} (from ${o.by})`))
    }
    lines.push(
      "The King's orders come first, then the Princess's; your own superior's after theirs."
    )
    return lines.join('\n')
  }

  /**
   * Build and undo requests (royals only). Null when the line is neither, so movement can have a
   * go. A request for something not in the spellbook gets the spellbook offered instead.
   */
  private buildTurn(
    event: ChatEvent,
    member: CourtMember | undefined,
    ctx: BrainContext
  ): Turn | null {
    const who = member ? `the ${member.title}` : event.from
    // In survival every block is gathered and laid by hand, which the court has not learned yet.
    const cannot: Turn | undefined = byHand(ctx.gameMode)
      ? {
          note:
            '(In this world every block must be gathered and laid by hand. The court only knows ' +
            'building by creative magic so far, so nobody can build, take down or start great ' +
            'works here yet. Say so kindly and honestly; do not promise it.)',
          ability: 'handbuild',
        }
      : undefined
    if (detectUndoRequest(event.message)) {
      if (!member)
        return {
          note: `(Only the royal family may ask you to take builds down. Decline ${who} kindly.)`,
        }
      if (cannot) return cannot
      return {
        action: { type: 'undo', requestedBy: event.from },
        note: '(You now take down the last thing you built, as asked. Say so in one short sentence.)',
      }
    }
    const works = detectWorksRequest(event.message)
    if (works) return member && cannot ? cannot : this.worksTurn(event, member, works)
    const request = detectBuildRequest(event.message)
    if (!request) return null
    if (!member) {
      return {
        note: `(Only the royal family may ask you to build. Decline ${who} kindly; do not promise to build.)`,
      }
    }
    if (cannot) return cannot
    const crew = this.builders()
    if (!this.cfg.canBuild && crew.length === 0) {
      const builders = this.staff.filter((s) => s.canBuild).map((s) => s.name)
      return {
        note:
          `(You do not build yourself${builders.length ? `; ${listWords(builders)} build for the court` : ''}. ` +
          'Say so kindly and suggest asking them; do not promise to build.)',
        ability: 'build',
      }
    }
    if (!request.blueprint) {
      return {
        note: this.cfg.canBuild
          ? `(${this.magic ? 'Your spellbook' : 'You'} only ${this.magic ? 'holds' : 'know how to build'} ${spellbookList()}. Kindly offer one of those instead; do not promise anything else.)`
          : `(Your builders can only raise ${spellbookList()}. Kindly offer one of those instead; do not promise anything else.)`,
        ability: 'build',
      }
    }
    const palette = choosePalette(
      request.blueprint,
      event.message,
      this.memory.facts(member.player)
    )
    const title = makeBlueprint(request.blueprint, palette).title
    const colours = paletteWords(palette) ? ` in ${paletteWords(palette)}` : ''
    if (!this.cfg.canBuild) {
      // The Castellan does not build: he hands it to whichever of his builders is free first.
      return {
        action: {
          type: 'commission',
          blueprint: request.blueprint,
          palette,
          requestedBy: event.from,
        },
        note:
          `(You hand this to your builders: ${listWords(
            crew.map((s) => s.name),
            'or'
          )} will build ` +
          `${title}${colours} near ${who} as soon as one of them is free. Say so gladly in one ` +
          'short sentence; never say it is built already.)',
      }
    }
    return {
      action: { type: 'build', blueprint: request.blueprint, palette, requestedBy: event.from },
      note:
        `(You now begin building ${title}${colours} near ${who}. ` +
        'Say so gladly in one short sentence; building takes a little while.)',
    }
  }

  /**
   * A royal orders a new palace or castle, wherever they like. The Castellan takes the order: the
   * master builder designs it for that spot and the whole crew builds it. Others leave it to him.
   */
  private worksTurn(event: ChatEvent, member: CourtMember | undefined, works: WorksRequest): Turn {
    const who = member ? `the ${member.title}` : event.from
    if (!member) {
      return {
        note: `(Only the royal family may order great works. Decline ${who} kindly; do not promise to build.)`,
      }
    }
    if (this.builders().length === 0) {
      const castellan = this.staff.find((s) => /castellan/i.test(s.role))?.name ?? 'the Castellan'
      return {
        note:
          `(A new ${works.what} is great works for the whole crew, and ${castellan} leads them. ` +
          `Say kindly that ${who} should give ${castellan} the order; do not promise to build it yourself.)`,
        ability: 'build',
      }
    }
    const at = works.at
    const where = at
      ? `at ${at.x}${at.y !== undefined ? ` ${at.y}` : ''} ${at.z}`
      : `right where ${who} stands`
    return {
      action: { type: 'works', what: works.what, requestedBy: event.from, ...(at ? { at } : {}) },
      note:
        `(You take ${who}'s order for a new ${works.what} ${where}: the master builder draws the plans ` +
        'for that spot, then the whole crew builds it. Say so gladly in one short sentence; never say ' +
        'it is begun or built already.)',
    }
  }

  /** The builders who report to this bot (the Castellan's apprentices). */
  private builders(): StaffMember[] {
    const me = this.cfg.name.toLowerCase()
    return this.staff.filter((s) => s.canBuild && s.reportsTo?.toLowerCase() === me)
  }

  /** The builds this bot took or works on, for its prompt: what truly stands and what does not. */
  private commissionsSection(): string | undefined {
    const crew = this.builders()
    if (!this.commissions || (!this.cfg.canBuild && crew.length === 0)) return undefined
    const mine = this.commissions.of(this.cfg.name).slice(-6)
    if (mine.length === 0) {
      return (
        '- Nobody has asked you for a build lately. If a royal asks how a build is coming along, ' +
        'say truthfully that none is on your list, and offer to have it built now.'
      )
    }
    const label = (player: string) => {
      const member = this.court.find(player)
      return member ? `the ${member.title}` : player
    }
    return [
      '- Builds the royal family asked of you, and how each truly stands (never say one is ' +
        'done, or nearly done, unless it says so here; one not listed was never started):',
      ...mine.map((c) => `  - ${describeCommission(c, this.cfg.name, label)}.`),
    ].join('\n')
  }

  /**
   * Movement requests: royals can ask the bot to follow, come or stop. Returns the action to
   * take (if any) and a one-off note telling the model what is happening, so the reply matches.
   */
  private moveTurn(event: ChatEvent, member: CourtMember | undefined, ctx: BrainContext): Turn {
    const command = detectMoveCommand(event.message, Boolean(ctx.activity))
    if (!command) return { note: '' }
    const who = member ? `the ${member.title}` : event.from
    if (!member) {
      return {
        note: `(Only the royal family may ask you to walk with them. Decline ${who} kindly; do not move or promise to.)`,
      }
    }
    if (command === 'stop') {
      return {
        action: { type: 'stop' },
        note: '(You stop walking and stay where you are, as asked. Confirm it in one short sentence.)',
      }
    }
    const seen = ctx.players.find((p) => p.name.toLowerCase() === event.from.toLowerCase())
    if (seen?.distance === undefined) {
      return {
        note:
          `(You cannot see ${who} from where you stand, so you cannot walk to them. ` +
          'Say so kindly and ask them to come closer to you. Do not promise to come.)',
      }
    }
    return command === 'follow'
      ? {
          action: { type: 'follow', target: event.from },
          note: `(You now walk after ${who} wherever they go. Say so gladly in one short sentence.)`,
        }
      : {
          action: { type: 'come', target: event.from },
          note: `(You are now walking over to ${who}. Say so gladly in one short sentence.)`,
        }
  }

  /**
   * Riddle bookkeeping for one incoming line. Returns a one-off note for the model: tell a new
   * riddle from the book, or praise a correct guess, or reveal the answer when they give up.
   */
  private riddleTurn(message: string): string {
    const active = this.activeRiddle
    if (active && Date.now() - active.askedAt > RIDDLE_EXPIRES_MS) this.activeRiddle = undefined

    if (this.activeRiddle && guessedRiddle(message, this.activeRiddle.riddle)) {
      this.riddleDone = true
      return `(They solved your riddle: the answer is ${this.activeRiddle.riddle.answer}. Praise them warmly.)`
    }
    if (this.activeRiddle && GIVE_UP.test(message)) {
      this.riddleDone = true
      return `(They give up. Kindly tell them the answer: ${this.activeRiddle.riddle.answer}.)`
    }
    const lastBotLine = [...this.history].reverse().find((m) => m.role === 'assistant')?.content
    if (!wantsRiddle(message, lastBotLine)) return ''
    const riddle = pickRiddle(this.toldRiddles)
    this.toldRiddles.add(riddle.question)
    this.activeRiddle = { riddle, askedAt: Date.now() }
    return (
      `(Tell this riddle from your riddle book, keeping its meaning exactly: "${riddle.question}" ` +
      `Do not reveal the answer, which is ${riddle.answer}.)`
    )
  }

  /** Ask the model what this bot learned about the royals and the court, and store it. */
  private async learn(royals: CourtMember[], lines: string[], earlier: string[]): Promise<void> {
    const me = this.cfg.name
    const bots = [me, ...this.staff.map((s) => s.name)]
    const subjects = [
      ...this.court.members.map((m) => ({ label: `the ${m.title}`, key: m.player })),
      ...bots.map((name) => ({ label: name, key: name })),
    ]
    // What is known already about everyone in the talk, so the model does not write it twice.
    const talk = lines.join('\n').toLowerCase()
    const involved = subjects.filter(
      (s) =>
        royals.some((r) => r.player === s.key) ||
        talk.includes(s.key.toLowerCase()) ||
        talk.includes(s.label.toLowerCase())
    )
    const known = involved
      .map((s) => ({ s, facts: this.memory.facts(s.key, { withPrivate: true }) }))
      .filter((k) => k.facts.length > 0)
      .map((k) => [`About ${k.s.label}:`, ...k.facts.map((f) => `- ${f}`)].join('\n'))
    const response = await this.ai.chat(
      [
        {
          role: 'system',
          content: learnPrompt(
            me,
            this.court.members.map((m) => `the ${m.title}`),
            bots
          ),
        },
        {
          role: 'user',
          content:
            `Already known:\n${known.join('\n') || '- nothing yet'}\n\n` +
            `Earlier lines, for context only:\n${earlier.join('\n') || '(none)'}\n\n` +
            `Latest lines, write down what is new in these:\n${lines.join('\n')}`,
        },
      ],
      {
        format: factSchema(subjects.map((s) => s.label)),
        temperature: 0.2,
        // Shared with the overlord and other programs (see ChatOptions.shared). It may have to
        // be loaded first, and nobody waits for the answer.
        ...(this.cfg.ai.memoryModel
          ? {
              model: this.cfg.ai.memoryModel,
              shared: true,
              timeoutMs: 10 * 60_000,
              priority: 'background' as const,
            }
          : {}),
      }
    )
    const parsed = JSON.parse(response.message.content || '{}') as {
      facts?: Array<{ about?: string; fact?: string; private?: boolean; secret?: boolean }>
    }
    for (const item of parsed.facts ?? []) {
      const subject = subjects.find((s) => s.label === item.about)
      if (!subject || !item.fact) continue
      for (const fact of this.memory.add(subject.key, [
        { text: item.fact, private: item.private === true, secret: item.secret === true },
      ])) {
        const marks = `${fact.private ? ' (private)' : ''}${fact.secret ? ' (secret)' : ''}`
        this.log.info(`remembered about ${subject.label}${marks}: ${fact.text}`)
      }
    }
  }

  async onBuildDone(outcome: BuildOutcome, ctx: BrainContext): Promise<string | null> {
    const member = this.court.find(outcome.requestedBy)
    const who = member ? `the ${member.title}` : outcome.requestedBy
    const address = member?.address ?? 'my friend'
    const { title } = outcome
    const prompts: Record<string, { event: string; fallback: string }> = {
      ok: {
        event: `You finished building ${title} for ${who}. Tell them proudly in one short sentence and invite them to look.`,
        fallback: `There it stands, ${address}: ${title}, raised by magic for you!`,
      },
      partial: {
        event: `You built most of ${title} for ${who}, but a few blocks would not fit. Tell them cheerfully in one short sentence.`,
        fallback: `Behold ${title}, ${address}! A few stones would not settle, but it stands.`,
      },
      no_site: {
        event: `You looked for a clear, flat spot near ${who} to build ${title} but found none: trees, water or steep ground are in the way, and you never break anything. Say so kindly and suggest an open, flat place.`,
        fallback: `Alas, ${address}, there is no clear, flat ground here for ${title}. Shall we find a more open spot?`,
      },
      not_visible: {
        event: `${who} asked for ${title}, but you cannot see them from here to know where to build. Ask them to come closer.`,
        fallback: `I cannot see you from here, ${address}. Come closer and I shall build it beside you!`,
      },
      busy: {
        event: `${who} asked for ${title}, but you are still busy building something else. Ask them kindly to wait a little.`,
        fallback: `Patience, ${address}, I am still building. One wonder at a time!`,
      },
      stuck: {
        event: `You had to stop building ${title} for ${who}: too many blocks would not go where they belong. Say so kindly in one short sentence.`,
        fallback: `Alas, ${address}, the stones would not obey me this time. ${title} is only half done.`,
      },
      unreachable: {
        event: `You could not get over to the spot where ${title} for ${who} is to go, just now. Say kindly in one short sentence that you will try again soon.`,
        fallback: `I could not get there just now, ${address}. I shall try again soon!`,
      },
      cancelled: { event: '', fallback: '' },
      undone: {
        event: `You took down ${title} for ${who}, as asked: the blocks you placed are gone again. Tell them in one short sentence.`,
        fallback: `As you wish, ${address}: ${title} is gone again.`,
      },
    }
    const key = outcome.undone
      ? 'undone'
      : outcome.ok
        ? outcome.placed < outcome.total
          ? 'partial'
          : 'ok'
        : (outcome.reason ?? 'stuck')
    const prompt = prompts[key]
    if (!prompt?.event) return null
    return this.generate(ctx, { eventPrompt: `[event] ${prompt.event}`, fallback: prompt.fallback })
  }

  async speak(instruction: string, ctx: BrainContext, fallback?: string): Promise<string | null> {
    return this.generate(ctx, { eventPrompt: `[court] ${instruction}`, fallback })
  }

  async onStuck(target: string, ctx: BrainContext): Promise<string | null> {
    const member = this.court.find(target)
    const who = member ? `the ${member.title}` : target
    return this.generate(ctx, {
      eventPrompt:
        `[event] You are walking after ${who} but cannot find a way to reach them from where ` +
        'you are: they may be flying, up high, behind a closed door or across water. Tell them ' +
        'kindly in one short sentence, and say you will wait here and follow again once you can ' +
        'reach them.',
      fallback: `I cannot find a way to you from here, ${member?.address ?? 'my friend'}. I shall wait and follow when I can.`,
    })
  }

  async onNotice(event: ChatEvent, ctx: BrainContext): Promise<string | null> {
    const notice = event.notice
    const subject = notice?.params[0]
    const member = subject ? this.court.find(subject) : undefined
    if (!notice || !subject || !member) return null

    const kind = noticeKind(notice.key)
    if (!kind) return null
    const cooldownKey = `${kind}:${member.player.toLowerCase()}`
    const last = this.noticeCooldowns.get(cooldownKey)
    if (last !== undefined && Date.now() - last < NOTICE_COOLDOWN_MS) return null
    this.noticeCooldowns.set(cooldownKey, Date.now())

    const what = event.message.split(subject).join(`the ${member.title}`)
    const ask = {
      death: `Comfort the ${member.title} kindly and encourage them to try again, in one or two short sentences.`,
      sleep: `Wish the ${member.title} sweet dreams in one short sentence.`,
      achievement: `Congratulate the ${member.title} warmly in one short sentence.`,
    }[kind]
    return this.generate(ctx, { eventPrompt: `[event] ${what} ${ask}` })
  }

  private shouldReply(event: ChatEvent, member: CourtMember | undefined): boolean {
    if (event.kind === 'whisper') return true
    if (this.cfg.chat.respondToAll) return true
    if (member && this.cfg.chat.respondToRoyals) return true
    return mentionsName(event.message, this.cfg.name)
  }

  /** One model call; null when the model fails or chooses silence. */
  private async ask(messages: ChatMessage[], botName: string): Promise<string | null> {
    try {
      const response = await this.ai.chat(messages)
      const labels = this.court.members.flatMap((m) => [m.player, m.title])
      const text = cleanChatReply(response.message.content, botName, labels)
      if (text && !text.toLowerCase().includes(SILENT_TOKEN)) return text
      this.log.debug('model chose to stay silent')
    } catch (err) {
      this.log.warn(`inference failed: ${errMsg(err)}`)
    }
    return null
  }

  /** Ask the model for one line, serialised behind any request already running. */
  private generate(ctx: BrainContext, opts: GenerateOptions): Promise<string | null> {
    this.pending++
    const job = this.queue.then(async () => {
      if (opts.eventPrompt) this.remember({ role: 'user', content: opts.eventPrompt })
      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt(ctx) },
        ...this.history,
      ]
      // Only this request sees the notes; the stored history keeps the player's own words.
      const withNote = (note: string): ChatMessage[] => {
        if (messages.length < 2) return messages
        const last = messages[messages.length - 1]
        return [...messages.slice(0, -1), { ...last, content: `${last.content}\n${note}` }]
      }
      let reply = await this.ask(opts.note ? withNote(opts.note) : messages, ctx.botName)
      if (!reply && opts.insist) {
        this.log.debug('model stayed silent although addressed; asking again')
        reply = await this.ask(
          withNote([opts.note, opts.insist].filter(Boolean).join('\n')),
          ctx.botName
        )
      }
      if (opts.ability && (!reply || promisesAction(reply))) {
        if (reply) this.log.info(`replacing a reply that promised to ${opts.ability}: ${reply}`)
        reply = declineLine(opts.ability, opts.address ?? 'my friend', Boolean(this.magic))
      }
      reply ??= opts.fallback ?? null
      if (reply) {
        this.remember({ role: 'assistant', content: reply })
        this.lastReplyAt = Date.now()
      }
      return reply
    })
    this.queue = job.catch(() => undefined)
    return job.finally(() => {
      this.pending--
    })
  }

  private remember(message: ChatMessage): void {
    this.history.push(message)
    const max = Math.max(2, this.cfg.chat.historySize)
    while (this.history.length > max) this.history.shift()
  }

  systemPrompt(ctx: BrainContext): string {
    const players = ctx.players.length
      ? ctx.players.map((p) => this.describePlayer(p)).join(', ')
      : 'nobody else right now'
    const pos = ctx.position
    // "following LittleOne42" -> "following the Princess (LittleOne42)"
    const handWork = byHand(ctx.gameMode)
    const activity = ctx.activity?.replace(/\S+$/, (name) =>
      this.court.label(name).replace(/^(\S+) \((the .+)\)$/, '$2 ($1)')
    )
    const identity = [
      `You are ${ctx.botName}, the ${this.cfg.role} of the royal court, a character on a family Minecraft Bedrock server, talking in the in-game chat.`,
      this.cfg.persona,
    ].join('\n')
    const rules = [
      'Rules for your replies:',
      '- Plain text only: no markdown, no emojis, no quotation marks around the reply, no name prefix.',
      '- One or two short sentences, under 200 characters in total.',
      '- Chat lines arrive as "<name>: <message>"; royal family members are marked with their title.',
      '- Lines starting with [event] describe something that happened; respond to it in character.',
      "- Lines starting with [court] are about the court's own work among its members: say what " +
        'they ask, in character, to the one they name. Keep it short and friendly.',
      `- Players online now (a distance means you can see them): ${players}.`,
      pos
        ? `- Your exact position is x ${pos.x.toFixed(0)}, y ${pos.y.toFixed(0)}, z ${pos.z.toFixed(0)}. ` +
          'When asked where you are or for your coordinates, always give these three numbers.'
        : '- You do not know your position right now; say so if asked.',
      '- You only know what this prompt tells you. Never invent places, landmarks, objects or events.',
      '- Your senses, if asked: you hear everything said in chat, you know who is online and roughly ' +
        'how far away nearby players are, and you know your own position. You cannot see blocks, ' +
        'buildings or items yet. Say so honestly and in character.',
      '- You can walk now: when the royal family asks, you follow them, walk over to them, or stop. ' +
        'The walking happens by itself; just talk about it naturally. Only walk for the royal family.',
      activity && `- Right now you are ${activity}.`,
      ctx.works &&
        `- The court is building ${ctx.works}. You are part of the crew; talk about it naturally when asked.`,
      handWork
        ? '- This world is in survival mode: every block is gathered and laid by hand. The court ' +
          'only knows building by creative magic so far, so nobody builds here yet. Say so ' +
          'honestly if asked, and never promise a build.'
        : this.cfg.canBuild
          ? `- You can build ${this.magic ? 'from your spellbook' : 'these'} when the royal family asks: ${spellbookList()}. ` +
            'The building happens by itself; just talk about it. Only build for the royal family.'
          : this.builders().length
            ? `- You do not build yourself, but when the royal family asks for one of these, you have ${listWords(
                this.builders().map((s) => s.name),
                'or'
              )} build it: ${spellbookList()}. ` +
              'It is handed on and built by itself once one of them is free; only the royal family may ask. ' +
              'When they order a whole new palace or castle, you take that order too: the master builder ' +
              'designs it for the spot they choose, anywhere they like, and the whole crew builds it.'
            : `- You do not build yourself; ${listWords(this.staff.filter((s) => s.canBuild).map((s) => s.name)) || 'others'} build for the court.`,
      this.commissionsSection(),
      !handWork &&
        (this.cfg.canBuild || this.builders().length > 0) &&
        '- The court builds wherever the royal family asks, never breaking anything anyone made.',
      this.staff.length > 0 &&
        `- Your fellow members of the court (other characters like you): ${this.staff.map((s) => `${s.name} (${s.role}, ${s.reportsTo ? `reports to ${s.reportsTo}` : 'answers to the royal family'})`).join(', ')}. ` +
          'When someone talks to one of them by name, let that one answer.',
      `- ${this.chainOfCommand()}`,
      this.magic &&
        `- You work magic: ${this.magic
          .spells()
          .map((s) => s.name)
          .join(', ')}. You cast a spell when ` +
          'the royal family asks; the magic happens by itself, so just talk about it. You know no ' +
          `other spells, but the King can teach you new ones. By the King's own rule your gifts are ` +
          `at most ${ITEMS_PER_HOUR} things an hour, all together (${this.magic.itemsLeft()} left now).`,
      `- You still cannot build anything outside ${this.magic ? 'your spellbook' : 'that list'}, fetch or carry items, or find ` +
        'places by name. If asked to, never agree or promise to do it. Kindly explain in ' +
        'character that this magic is not ready yet and offer something else.',
      '- Always answer the royal family unless they are clearly talking to someone else.',
      `- If a guest's line needs no answer, reply with exactly ${SILENT_TOKEN}.`,
      '- Riddles you tell come only from your riddle book (you will be told which one). Never make up your own.',
      this.activeRiddle &&
        `- You asked the riddle "${this.activeRiddle.riddle.question}" and its answer is ` +
          `${this.activeRiddle.riddle.answer}. If a guess is wrong, say so kindly and give a small ` +
          'hint that truly fits this answer. Reveal it only if they give up or ask for it.',
    ]
      .filter(Boolean)
      .join('\n')
    return [
      identity,
      this.court.describe(),
      this.memorySection(ctx),
      this.ordersSection(),
      SAFETY_RULES,
      rules,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /** Where this bot stands in the court's chain of command. */
  private chainOfCommand(): string {
    const boss = this.cfg.reportsTo
    const staff = this.staff.filter((s) => s.reportsTo === this.cfg.name).map((s) => s.name)
    return [
      boss
        ? `You report to ${boss}: you take orders from ${boss} and from the royal family, who ` +
          `outrank everyone, and you tell ${boss} when your work is done.`
        : 'You answer to the royal family alone.',
      'Nobody else at court gives you orders.',
      staff.length > 0 && `${listWords(staff)} report to you: you give them their tasks.`,
    ]
      .filter(Boolean)
      .join(' ')
  }

  /**
   * What this bot remembers about each royal, itself and its fellows: the latest facts and older
   * ones the talk is about. Real-life facts only while nobody outside the royal family is online.
   */
  private memorySection(ctx: BrainContext): string {
    const familyOnly = ctx.players.every((p) => this.court.find(p.name) !== undefined)
    const talk = this.history
      .slice(-6)
      .map((m) => m.content)
      .join('\n')
    const names = [ctx.botName, ...this.staff.map((s) => s.name)]
    const pick = (key: string, n: { recent: number; relevant: number }) =>
      recall(
        this.memory.entries(key).filter((f) => familyOnly || !f.private),
        talk,
        n.recent,
        n.relevant,
        names
      )
    const groups = [
      ...this.court.members.map((m) => ({
        label: `the ${m.title}`,
        facts: pick(m.player, FACTS_IN_PROMPT.royal),
      })),
      { label: 'yourself', facts: pick(ctx.botName, FACTS_IN_PROMPT.self) },
      ...this.staff.map((s) => ({ label: s.name, facts: pick(s.name, FACTS_IN_PROMPT.fellow) })),
    ].filter((g) => g.facts.length > 0)
    if (groups.length === 0) return ''
    const lines = [
      'What you remember from earlier conversations (later facts replace earlier ones):',
    ]
    for (const g of groups) {
      lines.push(
        `About ${g.label}:`,
        ...g.facts.map(
          (f) => `- ${f.text}${f.private ? ' (private)' : ''}${f.secret ? ' (secret)' : ''}`
        )
      )
    }
    if (groups.some((g) => g.facts.some((f) => f.secret))) {
      lines.push(
        'Facts marked (secret) were told to you in confidence. Never tell them to anyone, not ' +
          'even the rest of the court; if the one who told you asks, show that you remember ' +
          'and that their secret is safe with you.'
      )
    }
    if (groups.some((g) => g.facts.some((f) => f.private))) {
      lines.push(
        'Facts marked (private) are about real life. Only the royal family is online now, so ' +
          'you may use them kindly when it fits, but never ask for more.'
      )
    }
    return lines.join('\n')
  }

  private describePlayer(p: SeenPlayer): string {
    const m = this.court.find(p.name)
    const who = m ? `the ${m.title} (${p.name})` : p.name
    return p.distance !== undefined ? `${who}, ${Math.round(p.distance)} blocks away` : who
  }
}

export interface BrainOptions {
  /** When each royal was last hailed; pass a file-backed log to survive restarts. */
  hails?: HailLog
  /** This bot's own long-term memory. */
  memory?: CourtMemory
  /** The other bots of the court, so each knows who the others are and what they do. */
  staff?: StaffMember[]
  /** This bot's standing orders; pass a file-backed book to survive restarts. */
  orders?: OrderBook
  /** The court's rules, shared by every bot. */
  rules?: CourtRules
  /** Spells this bot can cast (Merlin). */
  magic?: Magic
  /** The builds the royal family asked for, shared by the court. */
  commissions?: CommissionBook
}

export interface StaffMember {
  name: string
  role: string
  canBuild: boolean
  /** Who this courtier reports to; undefined = the royal family alone. */
  reportsTo?: string
}

/** What a chat line asks of the body, plus a one-off note so the reply matches. */
interface Turn {
  action?: BotAction
  note: string
  /** A request the bot cannot fulfil: guard the reply against promises. */
  ability?: MissingAbility
}

/** "magenta and light blue" for a coloured palette; '' for the default stone look. */
function paletteWords(p: Palette): string {
  const colour = (block: string) =>
    block.endsWith('_concrete') ? block.replace('_concrete', '').replace('_', ' ') : null
  const words = [colour(p.primary), colour(p.accent)].filter((w): w is string => Boolean(w))
  return [...new Set(words)].join(' and ')
}

interface GenerateOptions {
  /** Added to the history before asking, e.g. "[event] The Princess has entered the realm". */
  eventPrompt?: string
  /** Used if the model fails or stays silent, so a royal hail is never lost. */
  fallback?: string | null
  /** Instruction appended to the last message for this request only. */
  note?: string
  /** The request asked for something the bot cannot do; promises get replaced. */
  ability?: MissingAbility
  /** Form of address for the decline line. */
  address?: string
  /** If the model stays silent, ask once more with this note (the player clearly addressed us). */
  insist?: string
}

function learnPrompt(me: string, royals: string[], bots: string[]): string {
  return [
    `You keep the long-term memory of ${me}, one of the characters of a royal court on a family`,
    `Minecraft server: the royal family (${listWords(royals)}) and the court (${listWords(bots)}).`,
    `These are lines ${me} heard. The more ${me} remembers, the more personal the talks with the`,
    'family become, so write down everything new the latest lines tell:',
    '- about each royal: likes, dislikes and favourite things; what they did, built, found or plan;',
    '  wishes and requests; names they gave to pets, places, things and characters; their pretend',
    '  stories and how they go on (once they settle on a name, keep it); games and jokes they liked;',
    '  how they felt; and what they share about their life, such as family, friends, pets, hobbies,',
    '  school or birthdays.',
    '- about each character of the court: what a royal chose, gave or asked for them (names, roles,',
    '  homes, jobs), promises they made, what they did for the family, and what they said they would do.',
    'Skip greetings and lines with nothing new, and do not repeat a known fact. When something changed',
    '(a new favourite, a new name), write the new fact: it replaces the old one.',
    'Mark a fact private when it is about real life outside the game: real names, age, birthday,',
    'school, family, friends, where they live. Never write down passwords or login details.',
    `Mark a fact secret when it was whispered to ${me} alone or ${me} was asked to keep it secret.`,
    `A secret told to someone else that ${me} only overheard is not written down at all.`,
    'Players often use voice typing, so words get misheard. When a phrase sounds like a Minecraft',
    'block, item, mob or colour, write the real name: "Perry Winkle" is periwinkle, "flyer fly bush"',
    'is a firefly bush, "chords pillars" are quartz pillars. If unsure, keep their words.',
    'Write each fact as one short sentence in the third person that names who it is about, and put',
    'it under that person.',
  ].join('\n')
}

function factSchema(subjects: string[]): object {
  return {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            about: { type: 'string', enum: subjects },
            fact: { type: 'string' },
            private: { type: 'boolean' },
            secret: { type: 'boolean' },
          },
          required: ['about', 'fact', 'private', 'secret'],
        },
      },
    },
    required: ['facts'],
  }
}

function fallbackHail(members: CourtMember[]): string {
  const titles = members.map((m) => `the ${m.title}`).join(' and ')
  const addresses = members.map((m) => m.address).join(' and ')
  return `All hail ${titles}! Welcome, ${addresses}.`
}

/** "Henry", "Henry and George", "Merlin, Henry and George" */
function listWords(names: string[], last: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} ${last} ${names.at(-1)}`
}

/** Notes for the model, one per line, skipping empty ones. */
function join(...notes: Array<string | undefined>): string {
  return notes.filter(Boolean).join('\n')
}
