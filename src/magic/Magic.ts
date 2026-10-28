import fs from 'node:fs'
import path from 'node:path'
import type { Place } from './places'
import {
  BUILTIN_SPELLS,
  CREATURES,
  EFFECTS,
  GIFTS,
  commandsFor,
  cooldownOf,
  needs,
  spellProblems,
  type Spell,
  type SpellArgs,
  type Step,
} from './spells'

/** What the server said to a command. */
export interface CommandResult {
  ok: boolean
  /** How many targets it worked on. */
  count: number
  output: string[]
}

export type RunCommand = (command: string) => Promise<CommandResult>

/** A gift Merlin gave, and how to take it back once its day is over. */
export interface Gift {
  id: string
  /** Who received it. */
  to: string
  /** "a cake", "a magic saddle" */
  what: string
  undo: string[]
  at: number
  /** When it fades. */
  until: number
}

const DAY = 24 * 60 * 60_000
/** Gifts that cannot be taken back (eaten, placed, horse far away) are forgotten after a week. */
const GIVE_UP_MS = 7 * DAY
/** How often taking a gift back is tried again. */
const RETRY_MS = 30 * 60_000

interface Saved {
  learned?: Spell[]
  gifts?: Gift[]
  next?: number
}

/**
 * Merlin's magic: the spells he knows (built in, and taught by the King), their cooldowns, and
 * the gifts he still has to take back. File-backed.
 */
export class Magic {
  private learned: Spell[] = []
  private gifts: Gift[] = []
  private next = 1
  private readonly lastCast = new Map<string, number>()
  private readonly lastTry = new Map<string, number>()
  /**
   * Whether the server lets Merlin run commands right now (checked after each spawn). Offline
   * players have no account id, so the server cannot keep operator rights on disk: after a
   * server restart, or maybe a reconnect, "op Merlin" has to be typed in its console again.
   */
  available?: boolean

  constructor(
    private readonly opts: {
      file?: string
      /** The court's bots, for spells on the whole court. */
      court?: string[]
      places?: () => Place[]
    } = {}
  ) {
    if (opts.file && fs.existsSync(opts.file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as Saved
        this.learned = saved.learned ?? []
        this.gifts = saved.gifts ?? []
        this.next = saved.next ?? 1
      } catch {
        // A broken file: the built-in spells still work.
      }
    }
  }

  spells(): Spell[] {
    return [...BUILTIN_SPELLS, ...this.learned]
  }

  find(id: string): Spell | undefined {
    const key = id.toLowerCase()
    return this.spells().find((s) => s.id === key || s.name.toLowerCase() === key)
  }

  places(): Place[] {
    return this.opts.places?.() ?? []
  }

  place(name: string | undefined): Place | undefined {
    if (!name) return undefined
    const key = name.toLowerCase().trim()
    return this.places().find((p) => p.name.toLowerCase() === key)
  }

  /** How long until the spell can be cast again; 0 when it is ready. */
  wait(spell: Spell, now = Date.now()): number {
    const last = this.lastCast.get(spell.id)
    return last === undefined ? 0 : Math.max(0, last + cooldownOf(spell) - now)
  }

  /** What is wrong with a request for this spell, in plain words; undefined when it can be cast. */
  check(spell: Spell, args: SpellArgs): string | undefined {
    for (const need of needs(spell)) {
      if (need === 'place' && !this.place(args.place))
        return `it needs a place Merlin knows (${args.place ? `not "${args.place}"` : 'none was named'})`
      if (need === 'item' && !(args.item && GIFTS[args.item]))
        return `the gift must be one of: ${Object.keys(GIFTS).join(', ')}`
      if (need === 'creature' && !CREATURES.includes(args.creature as never))
        return `the creature must be one of: ${CREATURES.filter((c) => c !== 'fireworks_rocket').join(', ')}`
      if (need === 'effect' && !(args.effect && args.effect in EFFECTS))
        return `the effect must be one of: ${Object.keys(EFFECTS).join(', ')}`
    }
    return undefined
  }

  /** Problems with a spell the King describes (empty when Merlin can learn it). */
  problems(steps: unknown): string[] {
    return spellProblems(
      steps,
      this.places().map((p) => p.name)
    )
  }

  /** Learn a spell the King taught. Its steps must already be sound (see problems). */
  learn(spell: { name: string; does: string; steps: Step[] }, from: string): Spell {
    // A fixed place written by name becomes { place }.
    const steps = spell.steps.map((s): Step => {
      const place = s.kind === 'teleport' && typeof s.to === 'string' ? this.place(s.to) : undefined
      return place && s.kind === 'teleport' ? { ...s, to: { place: place.name } } : s
    })
    const base =
      spell.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '') || 'spell'
    let id = base
    for (let i = 2; this.find(id); i++) id = `${base}_${i}`
    const learned: Spell = {
      id,
      name: spell.name,
      does: spell.does,
      steps,
      learnedFrom: from,
    }
    this.learned.push(learned)
    this.save()
    return learned
  }

  /** Cast a spell: run its commands in order, keep its gifts, start its cooldown. */
  async cast(
    spell: Spell,
    args: SpellArgs,
    who: { requester: string; target: string; merlin: string },
    run: RunCommand,
    now = Date.now()
  ): Promise<{ ok: boolean; reason?: string }> {
    const giftId = String(this.next++)
    let casts
    try {
      casts = commandsFor(spell, {
        ...who,
        court: (this.opts.court ?? []).filter((n) => n !== who.merlin),
        placeOf: (name) => this.place(name),
        args,
        giftId,
      })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    for (const cast of casts) {
      const result = await run(cast.command)
      if (!result.ok) {
        if (cast.mustFind)
          return { ok: false, reason: `there is no horse without a saddle near ${who.target}` }
        return {
          ok: false,
          reason: `the server refused "${cast.command}": ${result.output.join('; ')}`,
        }
      }
      if (cast.undo) {
        const what = cast.command.startsWith('give') ? `${args.item ?? 'a gift'}` : 'a magic saddle'
        this.gifts.push({
          id: giftId,
          to: who.target,
          what,
          undo: cast.undo,
          at: now,
          until: now + DAY,
        })
        this.save()
      }
    }
    // The magic needs time to gather again only after it worked.
    this.lastCast.set(spell.id, now)
    return { ok: true }
  }

  /** Gifts whose day is over, for these players (the ones online), not tried a moment ago. */
  due(online: (player: string) => boolean, now = Date.now()): Gift[] {
    return this.gifts.filter(
      (g) =>
        g.until <= now && online(g.to) && now - (this.lastTry.get(g.id + g.what) ?? 0) > RETRY_MS
    )
  }

  /** Take a gift back. Returns true when it is gone; a gift that cannot be found is tried again later. */
  async takeBack(gift: Gift, run: RunCommand, now = Date.now()): Promise<boolean> {
    this.lastTry.set(gift.id + gift.what, now)
    let gone = true
    for (const command of gift.undo) {
      const result = await run(command)
      if (!result.ok) gone = false
    }
    if (gone || now - gift.at > GIVE_UP_MS) {
      this.gifts = this.gifts.filter((g) => g !== gift)
      this.save()
    }
    return gone
  }

  get pendingGifts(): Gift[] {
    return [...this.gifts]
  }

  private save(): void {
    const file = this.opts.file
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const saved: Saved = { learned: this.learned, gifts: this.gifts, next: this.next }
    fs.writeFileSync(file, JSON.stringify(saved, null, 2))
  }
}
