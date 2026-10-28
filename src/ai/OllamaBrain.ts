import type { BotConfig } from '../config'
import type { CourtMember, CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { makeBlueprint, spellbookList, type Palette } from '../build/blueprints'
import { choosePalette } from '../build/palette'
import type {
  BotAction,
  Brain,
  BrainContext,
  BrainReply,
  BuildOutcome,
  ChatEvent,
  SeenPlayer,
} from './Brain'
import {
  abilityNote,
  declineLine,
  detectBuildRequest,
  detectMissingAbility,
  detectMoveCommand,
  detectUndoRequest,
  promisesAction,
  type MissingAbility,
} from './abilities'
import { CourtMemory } from './CourtMemory'
import { guessedRiddle, pickRiddle, wantsRiddle, type Riddle } from './riddles'
import { HailLog } from './HailLog'
import type { ChatMessage, ChatModel } from './OllamaClient'
import { SILENT_TOKEN, cleanChatReply, mentionsName, mentionsNameLoosely } from './text'

/** Do not hail the same player again if they rejoin within this window. */
export const REHAIL_AFTER_MS = 10 * 60_000

/** An unanswered riddle is forgotten after this long. */
const RIDDLE_EXPIRES_MS = 15 * 60_000

/** The player gives up on a riddle ("I don't know" alone is not giving up: give a hint instead). */
const GIVE_UP = /\b(give up|tell me( the)? answer|what('?s| is) the answer|just tell me)\b/i

/** How many remembered facts per subject go into the prompt (the most recent ones). */
const MEMORY_FACTS_IN_PROMPT = 15

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
  '- Never ask for or repeat personal information such as real names, ages, addresses, schools or passwords.',
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
  private readonly memory: CourtMemory
  private readonly learns: boolean
  private readonly staff: StaffMember[]
  private learning: Promise<void> = Promise.resolve()
  /** The riddle the bot asked and is waiting for an answer to. */
  private activeRiddle?: { riddle: Riddle; askedAt: number }
  /** Set when this turn solves or gives up the active riddle; cleared after the reply. */
  private riddleDone = false
  private readonly toldRiddles = new Set<string>()

  constructor(
    private readonly cfg: BotConfig,
    private readonly ai: ChatModel,
    private readonly court: CourtRoster,
    private readonly log: Logger,
    opts: BrainOptions = {}
  ) {
    this.hails = opts.hails ?? new HailLog()
    this.memory = opts.memory ?? new CourtMemory()
    this.learns = opts.learns ?? false
    this.staff = (opts.staff ?? []).filter((s) => s.name !== cfg.name)
  }

  /** Resolves once every memory extraction started so far has finished (for tests). */
  settled(): Promise<void> {
    return this.learning
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

    // Another bot of the court has the floor: listen (and, as scribe, still learn), but stay quiet.
    if (ctx.mayReply === false) {
      this.learnFrom(event, member, ctx.botName, null)
      return null
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
    // Building takes precedence over walking ("come and build a tower"); the rest is guarded.
    const turn = this.buildTurn(event, member) ?? this.moveTurn(event, member, ctx)
    const ability = turn.action ? undefined : (turn.ability ?? detectMissingAbility(event.message))
    const riddleNote = this.riddleTurn(event.message)
    const notes = [turn.note, ability ? abilityNote(ability, ctx.botName) : '', riddleNote].filter(
      Boolean
    )
    const move = turn
    const say = await this.generate(ctx, {
      note: notes.join('\n') || undefined,
      ...(ability ? { ability, address: member?.address ?? 'my friend' } : {}),
      // A royal who names the bot (even misspelled) or answers it gets a reply, not silence.
      insist:
        member && (answeringUs || mentionsNameLoosely(event.message, ctx.botName))
          ? `(${speaker} is talking to you, ${ctx.botName}: answer kindly.)`
          : undefined,
    })
    if (this.riddleDone) {
      this.activeRiddle = undefined
      this.riddleDone = false
    }
    this.learnFrom(event, member, ctx.botName, say)
    if (!say && !move.action) return null
    return move.action ? { say, action: move.action } : { say }
  }

  /** If this bot is the court's scribe, extract lasting facts from a royal's line (in the background). */
  private learnFrom(
    event: ChatEvent,
    member: CourtMember | undefined,
    botName: string,
    say: string | null
  ): void {
    if (!member || !this.learns) return
    // Capture the exchange now: more chat may arrive before the extraction runs.
    const said = `${this.court.label(event.from)}: ${event.message}`
    const exchange = say ? `${said}\n${botName}: ${say}` : said
    const earlier = this.transcript(botName, say ? -6 : -5, say ? -2 : -1)
    this.learning = this.learning
      .then(() => this.learn(member, botName, exchange, earlier))
      .catch((err) => this.log.warn(`memory extraction failed: ${errMsg(err)}`))
  }

  /**
   * Build and undo requests (royals only). Null when the line is neither, so movement can have a
   * go. A request for something not in the spellbook gets the spellbook offered instead.
   */
  private buildTurn(event: ChatEvent, member: CourtMember | undefined): Turn | null {
    const who = member ? `the ${member.title}` : event.from
    if (detectUndoRequest(event.message)) {
      if (!member)
        return {
          note: `(Only the royal family may ask you to take builds down. Decline ${who} kindly.)`,
        }
      return {
        action: { type: 'undo', requestedBy: event.from },
        note: '(You now take down the last thing you built, as asked. Say so in one short sentence.)',
      }
    }
    const request = detectBuildRequest(event.message)
    if (!request) return null
    if (!member) {
      return {
        note: `(Only the royal family may ask you to build. Decline ${who} kindly; do not promise to build.)`,
      }
    }
    if (!this.cfg.canBuild) {
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
        note: `(Your spellbook only holds ${spellbookList()}. Kindly offer one of those instead; do not promise anything else.)`,
        ability: 'build',
      }
    }
    const palette = choosePalette(
      request.blueprint,
      event.message,
      this.memory.facts(member.player)
    )
    const title = makeBlueprint(request.blueprint, palette).title
    const colours = paletteWords(palette)
    return {
      action: { type: 'build', blueprint: request.blueprint, palette, requestedBy: event.from },
      note:
        `(You now begin building ${title}${colours ? ` in ${colours}` : ''} near ${who}. ` +
        'Say so gladly in one short sentence; building takes a little while.)',
    }
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

  /** History lines in [start, end) as plain text, for the memory extractor. */
  private transcript(botName: string, start: number, end: number): string {
    return this.history
      .slice(start, end)
      .map((m) => (m.role === 'assistant' ? `${botName}: ${m.content}` : m.content))
      .join('\n')
  }

  /** Ask the model which lasting facts the latest exchange revealed, and store them. */
  private async learn(
    member: CourtMember,
    botName: string,
    exchange: string,
    earlier: string
  ): Promise<void> {
    const subjects = [
      { label: `the ${member.title}`, key: member.player },
      { label: botName, key: botName },
    ]
    const known = subjects.flatMap((s) => this.memory.facts(s.key).map((f) => `- ${f}`))
    const response = await this.ai.chat(
      [
        { role: 'system', content: learnPrompt(botName, `the ${member.title}`) },
        {
          role: 'user',
          content:
            `Already known:\n${known.join('\n') || '- nothing yet'}\n\n` +
            `Earlier lines, for context only:\n${earlier || '(none)'}\n\n` +
            `Latest exchange, extract facts from this only:\n${exchange}`,
        },
      ],
      {
        format: factSchema(subjects.map((s) => s.label)),
        temperature: 0.2,
        // Shared with the overlord and other programs (see ChatOptions.shared). It may have to
        // be loaded first, and nobody waits for the answer.
        ...(this.cfg.ai.memoryModel
          ? { model: this.cfg.ai.memoryModel, shared: true, timeoutMs: 10 * 60_000 }
          : {}),
      }
    )
    const parsed = JSON.parse(response.message.content || '{}') as {
      facts?: Array<{ about?: string; fact?: string }>
    }
    for (const item of parsed.facts ?? []) {
      const subject = subjects.find((s) => s.label === item.about)
      if (!subject || !item.fact) continue
      for (const fact of this.memory.add(subject.key, [item.fact])) {
        this.log.info(`remembered about ${subject.label}: ${fact}`)
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
      outside_zone: {
        event: `${who} asked for ${title}, but you may only build on the royal grounds and they are too far from them. Say so kindly in one short sentence.`,
        fallback: `Alas, ${address}, I may only build on the royal grounds. Let us go there and I shall build it!`,
      },
      no_zone: {
        event: `${who} asked for ${title}, but you have not been granted any royal grounds to build on. Say so kindly in one short sentence.`,
        fallback: `Alas, ${address}, I have not been granted any grounds to build on yet.`,
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
        reply = declineLine(opts.ability, opts.address ?? 'my friend')
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
      this.cfg.canBuild
        ? `- You can build from your spellbook when the royal family asks: ${spellbookList()}. ` +
          'The building happens by itself; just talk about it. Only build for the royal family.'
        : `- You do not build yourself; ${listWords(this.staff.filter((s) => s.canBuild).map((s) => s.name)) || 'others'} build for the court.`,
      this.staff.length > 0 &&
        `- Your fellow members of the court (other characters like you): ${this.staff.map((s) => `${s.name} (${s.role})`).join(', ')}. ` +
          'When someone talks to one of them by name, let that one answer.',
      '- You still cannot build anything outside your spellbook, fetch or carry items, or find ' +
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
    return [identity, this.court.describe(), this.memorySection(ctx.botName), SAFETY_RULES, rules]
      .filter(Boolean)
      .join('\n\n')
  }

  /** What the court remembers about each royal and about this bot, most recent last. */
  private memorySection(botName: string): string {
    const groups = [
      ...this.court.members.map((m) => ({
        label: `the ${m.title}`,
        facts: this.memory.facts(m.player),
      })),
      { label: 'yourself', facts: this.memory.facts(botName) },
    ].filter((g) => g.facts.length > 0)
    if (groups.length === 0) return ''
    const lines = ['What you remember from earlier conversations:']
    for (const g of groups) {
      lines.push(
        `About ${g.label}:`,
        ...g.facts.slice(-MEMORY_FACTS_IN_PROMPT).map((f) => `- ${f}`)
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
  /** Long-term memory shared by the whole court. */
  memory?: CourtMemory
  /** This bot extracts new memories from conversations (one scribe per court avoids duplicates). */
  learns?: boolean
  /** The other bots of the court, so each knows who the others are and what they do. */
  staff?: StaffMember[]
}

export interface StaffMember {
  name: string
  role: string
  canBuild: boolean
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

function learnPrompt(botName: string, royal: string): string {
  return [
    `You keep the long-term memory of ${botName}, a character at the royal court on a family Minecraft server.`,
    'Read the latest exchange and pick out only NEW facts worth remembering in future conversations.',
    `What ${royal} says about themselves matters most: likes, dislikes and favourite things; wishes,`,
    'plans and requests; things built or to be built; names given to pets, places or things;',
    'and events in their pretend stories, such as a baby being born or the names they choose for',
    'characters (once they settle on a name, keep it).',
    `Also keep promises ${botName} made and what ${royal} chose or agreed for ${botName}.`,
    `Do not record ${botName}'s own idle opinions unless ${royal} asked for them and agreed.`,
    'Skip greetings, small talk, compliments, questions, and anything that repeats a known fact.',
    'Never record real-world personal information such as real names, age, birthday, address, school or passwords.',
    'Players often use voice typing, so words get misheard. When a phrase sounds like a Minecraft',
    'block, item, mob or colour, write the real name: "Perry Winkle" is periwinkle, "flyer fly bush"',
    'is a firefly bush, "chords pillars" are quartz pillars. If unsure, keep their words.',
    `Write each fact as one short sentence in the third person, using "${royal}" or "${botName}".`,
    'Usually there is nothing new: then return an empty list.',
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
          },
          required: ['about', 'fact'],
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
function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
