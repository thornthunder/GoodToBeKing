import { describe, expect, it, vi } from 'vitest'
import { defaultBotConfig, type BotConfig } from '../config'
import { CourtRoster } from '../court'
import { createLogger } from '../logger'
import type { BrainContext, ChatEvent } from './Brain'
import { CourtMemory } from './CourtMemory'
import { HailLog } from './HailLog'
import { OllamaBrain, type BrainOptions } from './OllamaBrain'
import type { ChatMessage, ChatModel } from './OllamaClient'
import { CourtRules, OrderBook, type Reading } from './orders'
import { Magic } from '../magic/Magic'
import { CommissionBook } from '../build/Commissions'
import { DEFAULT_PALETTE } from '../build/blueprints'

const court = new CourtRoster({
  realm: 'Testland',
  charter: 'Serve the royal family.',
  members: [
    { player: 'LittleOne42', role: 'princess', title: 'Princess', address: 'Your Highness' },
    { player: 'BigDad', role: 'king', title: 'King', address: 'Your Majesty' },
  ],
})

type FakeReply = string | Error | ((messages: ChatMessage[]) => string)

const NO_ORDER: Reading = {
  type: 'none',
  forMe: false,
  summary: '',
  lasting: false,
  clashes: [],
  releases: [],
}

function makeBrain(
  reply: FakeReply,
  overrides: Partial<BotConfig['chat']> = {},
  hails = new HailLog(),
  extra: Omit<BrainOptions, 'hails'> = {}
) {
  const calls: ChatMessage[][] = []
  const chat = vi.fn(async (messages: ChatMessage[]) => {
    calls.push(messages)
    if (reply instanceof Error) throw reply
    const content = typeof reply === 'function' ? reply(messages) : reply
    return { message: { role: 'assistant', content } } as Awaited<ReturnType<ChatModel['chat']>>
  })
  // Reading a royal's line for orders is its own call: answered from `readings` (none by default).
  const readings: Array<Partial<Reading>> = []
  const reads: ChatMessage[][] = []
  const model = { chat }
  const routed: ChatModel = {
    chat: async (messages) => {
      if (!messages[0].content.startsWith('You help')) return chat(messages)
      reads.push(messages)
      const reading = { ...NO_ORDER, ...readings.shift() }
      return { message: { role: 'assistant', content: JSON.stringify(reading) } } as never
    },
  }
  const base = defaultBotConfig()
  const cfg: BotConfig = {
    ...base,
    name: 'Merlin',
    chat: { ...base.chat, greeting: 'Hello all', ...overrides },
  }
  const brain = new OllamaBrain(cfg, routed, court, createLogger('test'), { hails, ...extra })
  return { brain, calls, model, readings, reads }
}

const ctx = (...names: string[]): BrainContext => ({
  botName: 'Merlin',
  players: names.map((name) => ({ name })),
})

/** Like ctx, but the bot can see everyone (a distance is known). */
const seen = (...names: string[]): BrainContext => ({
  botName: 'Merlin',
  players: names.map((name) => ({ name, distance: 5 })),
})

const chat = (from: string, message: string): ChatEvent => ({
  from,
  message,
  kind: 'chat',
  receivedAt: Date.now(),
})

describe('OllamaBrain court behaviour', () => {
  it('hails a royal who joins, with a prompt naming the title', async () => {
    const { brain, calls } = makeBrain('Hail, Your Highness!')
    const reply = await brain.onPlayerJoin('LittleOne42', ctx('LittleOne42'))
    expect(reply).toBe('Hail, Your Highness!')
    const last = calls[0].at(-1)?.content ?? ''
    expect(last).toContain('The Princess has just entered the realm')
  })

  it('falls back to a fixed hail when the model fails', async () => {
    const { brain } = makeBrain(new Error('ollama down'))
    const reply = await brain.onPlayerJoin('LittleOne42', ctx('LittleOne42'))
    expect(reply).toBe('All hail the Princess! Welcome, Your Highness.')
  })

  it('does not hail the same royal twice in a short time', async () => {
    const { brain } = makeBrain('Hail!')
    expect(await brain.onPlayerJoin('LittleOne42', ctx('LittleOne42'))).toBe('Hail!')
    expect(await brain.onPlayerJoin('littleone42', ctx('LittleOne42'))).toBeNull()
  })

  it('hails royals already present on spawn instead of the plain greeting', async () => {
    const { brain, calls } = makeBrain('Greetings, Your Majesty and Your Highness!')
    const reply = await brain.onSpawn(ctx('BigDad', 'LittleOne42', 'Stranger'))
    expect(reply).toBe('Greetings, Your Majesty and Your Highness!')
    expect(calls[0].at(-1)?.content).toContain('the King and the Princess are here')
  })

  it('says it is back instead of hailing again after a quick restart', async () => {
    const hails = new HailLog()
    hails.set('LittleOne42')
    const { brain, calls } = makeBrain("I'm back, Your Highness.", {}, hails)
    expect(await brain.onSpawn(ctx('LittleOne42'))).toBe("I'm back, Your Highness.")
    expect(calls[0].at(-1)?.content).toContain('Say in one short sentence that you are back')
  })

  it('hails only the royals it has not greeted recently', async () => {
    const hails = new HailLog()
    hails.set('LittleOne42')
    const { brain, calls } = makeBrain('Greetings, Your Majesty!', {}, hails)
    await brain.onSpawn(ctx('LittleOne42', 'BigDad'))
    const last = calls[0].at(-1)?.content ?? ''
    expect(last).toContain('the King is here')
    expect(last).not.toContain('Princess')
  })

  it('uses the plain greeting on spawn when no royal is online', async () => {
    const { brain, model } = makeBrain('unused')
    expect(await brain.onSpawn(ctx('Stranger'))).toBe('Hello all')
    expect(model.chat).not.toHaveBeenCalled()
  })

  it('answers royals without being addressed by name', async () => {
    const { brain, calls } = makeBrain('Of course, Your Highness.')
    const reply = await brain.onChat(chat('LittleOne42', 'can you help me?'), ctx('LittleOne42'))
    expect(reply?.say).toBe('Of course, Your Highness.')
    expect(calls[0].at(-1)?.content).toBe('LittleOne42 (the Princess): can you help me?')
  })

  it('asks again when a royal names it (misspelled) and the model stays silent', async () => {
    let n = 0
    const { brain, calls } = makeBrain(() =>
      n++ === 0 ? '[silent]' : 'You are too kind, Your Highness.'
    )
    const reply = await brain.onChat(
      chat('LittleOne42', 'a very kind Marlon you are'),
      ctx('LittleOne42')
    )
    expect(reply?.say).toBe('You are too kind, Your Highness.')
    expect(calls).toHaveLength(2)
    expect(calls[1].at(-1)?.content).toContain('The Princess is talking to you, Merlin')
  })

  it('asks again when a royal answers its last line and the model stays silent', async () => {
    let n = 0
    const { brain, calls } = makeBrain(
      () => ['Shall I tell you a tale?', '[silent]', 'Then a tale it is!'][n++] ?? 'unused'
    )
    await brain.onChat(chat('LittleOne42', 'hello Merlin'), ctx('LittleOne42'))
    const reply = await brain.onChat(chat('LittleOne42', 'I give up'), ctx('LittleOne42'))
    expect(reply?.say).toBe('Then a tale it is!')
    expect(calls).toHaveLength(3)
  })

  it('accepts silence when a royal is clearly talking to someone else', async () => {
    const { brain, calls } = makeBrain('[silent]')
    expect(
      await brain.onChat(chat('LittleOne42', 'daddy look at this'), ctx('LittleOne42'))
    ).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('tells riddles from the book and keeps the answer until it is guessed', async () => {
    const { brain, calls } = makeBrain('A riddle for you!')
    await brain.onChat(chat('LittleOne42', 'tell me a riddle'), ctx('LittleOne42'))
    const note = calls[0].at(-1)?.content ?? ''
    expect(note).toContain('Tell this riddle from your riddle book')
    const question = note.match(/"([^"]+)"/)?.[1] ?? ''
    expect(question).not.toBe('')

    // While the riddle is open the system prompt carries its answer.
    const prompt = brain.systemPrompt(ctx('LittleOne42'))
    expect(prompt).toContain(`You asked the riddle "${question}"`)

    // A guess that contains the answer word ends the riddle.
    const answer = /its answer is (.+?)\. If a guess/.exec(prompt)?.[1] ?? ''
    await brain.onChat(chat('LittleOne42', `is it ${answer}?`), ctx('LittleOne42'))
    expect(calls[1].at(-1)?.content).toContain('They solved your riddle')
    expect(brain.systemPrompt(ctx('LittleOne42'))).not.toContain('You asked the riddle')
  })

  it('reveals the answer when they give up', async () => {
    const { brain, calls } = makeBrain('Here it is.')
    await brain.onChat(chat('LittleOne42', 'tell me a riddle'), ctx('LittleOne42'))
    await brain.onChat(chat('LittleOne42', 'I give up'), ctx('LittleOne42'))
    expect(calls[1].at(-1)?.content).toContain('They give up. Kindly tell them the answer')
    expect(brain.systemPrompt(ctx('LittleOne42'))).not.toContain('You asked the riddle')
  })

  it('ignores guests who do not address it', async () => {
    const { brain, model } = makeBrain('unused')
    expect(await brain.onChat(chat('Stranger', 'hello'), ctx('Stranger'))).toBeNull()
    expect(model.chat).not.toHaveBeenCalled()
  })

  it('answers guests who say its name', async () => {
    const { brain } = makeBrain('Welcome, traveller.')
    expect((await brain.onChat(chat('Stranger', 'hi Merlin'), ctx('Stranger')))?.say).toBe(
      'Welcome, traveller.'
    )
  })

  it('can be told not to answer royals unprompted', async () => {
    const { brain, model } = makeBrain('unused', { respondToRoyals: false })
    expect(await brain.onChat(chat('LittleOne42', 'hello'), ctx('LittleOne42'))).toBeNull()
    expect(model.chat).not.toHaveBeenCalled()
  })

  it('follows a royal it can see when asked, and says so', async () => {
    const { brain, calls } = makeBrain('Lead on, Your Highness!')
    const reply = await brain.onChat(chat('LittleOne42', 'Merlin follow me'), seen('LittleOne42'))
    expect(reply).toEqual({
      say: 'Lead on, Your Highness!',
      action: { type: 'follow', target: 'LittleOne42' },
    })
    expect(calls[0].at(-1)?.content).toContain('You now walk after the Princess')
  })

  it('walks over to a royal who calls it', async () => {
    const { brain } = makeBrain('Coming, Your Majesty!')
    const reply = await brain.onChat(chat('BigDad', 'come here merlin'), seen('BigDad'))
    expect(reply?.action).toEqual({ type: 'come', target: 'BigDad' })
  })

  it('does not move toward a royal it cannot see, and says why', async () => {
    const { brain, calls } = makeBrain('I cannot see you from here, Your Highness.')
    const reply = await brain.onChat(chat('LittleOne42', 'Merlin follow me'), ctx('LittleOne42'))
    expect(reply).toEqual({ say: 'I cannot see you from here, Your Highness.' })
    expect(calls[0].at(-1)?.content).toContain('You cannot see the Princess')
  })

  it('stops when a royal says so while it is walking', async () => {
    const { brain } = makeBrain('As you wish, I shall stay.')
    const walking = { ...seen('LittleOne42'), activity: 'following LittleOne42' }
    const reply = await brain.onChat(chat('LittleOne42', 'stop Merlin'), walking)
    expect(reply?.action).toEqual({ type: 'stop' })
  })

  it('never walks for a guest', async () => {
    const { brain, calls } = makeBrain('I serve the royal family, friend.')
    const reply = await brain.onChat(chat('Stranger', 'Merlin follow me'), seen('Stranger'))
    expect(reply).toEqual({ say: 'I serve the royal family, friend.' })
    expect(calls[0].at(-1)?.content).toContain('Only the royal family may ask you to walk')
  })

  it('explains kindly when it cannot reach the royal it follows', async () => {
    const { brain, calls } = makeBrain('Alas, I cannot reach you up there, Your Highness.')
    const reply = await brain.onStuck('LittleOne42', seen('LittleOne42'))
    expect(reply).toBe('Alas, I cannot reach you up there, Your Highness.')
    expect(calls[0].at(-1)?.content).toContain('cannot find a way to reach them')
  })

  it('thinks aloud when an answer for a royal takes a while, once a minute at most', async () => {
    vi.useFakeTimers()
    try {
      const slow: ChatModel = {
        chat: async (messages) => {
          if (messages[0].content.startsWith('You help'))
            return { message: { role: 'assistant', content: JSON.stringify(NO_ORDER) } } as never
          await new Promise((r) => setTimeout(r, 5_000))
          return { message: { role: 'assistant', content: 'Ah, the answer!' } } as never
        },
      }
      const base = defaultBotConfig()
      const cfg = {
        ...base,
        name: 'Merlin',
        chat: { ...base.chat, thinking: ['Hmm, my books...'] },
      }
      const brain = new OllamaBrain(cfg, slow, court, createLogger('test'))
      const said: string[] = []
      const context = { ...seen('LittleOne42'), interim: (t: string) => said.push(t) }
      const first = brain.onChat(chat('LittleOne42', 'Merlin, what is a dragon?'), context)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(said).toEqual(['Hmm, my books...'])
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await first)?.say).toBe('Ah, the answer!')
      // Within the minute, the next slow answer comes without one.
      const second = brain.onChat(chat('LittleOne42', 'Merlin, and a unicorn?'), context)
      await vi.advanceTimersByTimeAsync(8_000)
      await second
      expect(said).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the model what it is doing right now', () => {
    const { brain } = makeBrain('unused')
    const prompt = brain.systemPrompt({ ...seen('LittleOne42'), activity: 'following LittleOne42' })
    expect(prompt).toContain('Right now you are following the Princess (LittleOne42).')
  })

  it('builds from the spellbook for a royal, in the colours they love', async () => {
    const memory = new CourtMemory()
    memory.add('LittleOne42', ['The Princess loves magenta.', 'The Princess loves periwinkle.'])
    const { brain, calls } = makeBrain('At once, Your Highness!', {}, new HailLog(), { memory })
    const reply = await brain.onChat(
      chat('LittleOne42', 'Merlin build me a tower'),
      seen('LittleOne42')
    )
    expect(reply?.action).toMatchObject({
      type: 'build',
      blueprint: 'tower',
      requestedBy: 'LittleOne42',
      palette: { primary: 'magenta_concrete', accent: 'light_blue_concrete' },
    })
    expect(calls[0].at(-1)?.content).toContain(
      'You now begin building a little tower in magenta and light blue near the Princess'
    )
  })

  it('builds a castle when asked, and something from the book for "anything"', async () => {
    const { brain } = makeBrain('Gladly!')
    const castle = await brain.onChat(chat('BigDad', 'Merlin build a castle'), seen('BigDad'))
    expect(castle?.action).toMatchObject({ type: 'build', blueprint: 'castle' })
    const anything = await brain.onChat(
      chat('BigDad', 'can you build something for me, anything'),
      seen('BigDad')
    )
    expect(anything?.action).toMatchObject({ type: 'build', blueprint: 'tower' })
  })

  it('takes down its last build when a royal asks', async () => {
    const { brain } = makeBrain('As you wish.')
    const reply = await brain.onChat(chat('BigDad', 'Merlin take it down please'), seen('BigDad'))
    expect(reply?.action).toEqual({ type: 'undo', requestedBy: 'BigDad' })
  })

  it('never builds for a guest', async () => {
    const { brain, calls } = makeBrain('I build only for the royal family.')
    const reply = await brain.onChat(chat('Stranger', 'Merlin build a tower'), seen('Stranger'))
    expect(reply?.action).toBeUndefined()
    expect(calls[0].at(-1)?.content).toContain('Only the royal family may ask you to build')
  })

  it('offers what it can build, and replaces a promise, for something it cannot', async () => {
    const { brain, calls } = makeBrain('I will build you the finest house, little Princess.')
    const reply = await brain.onChat(
      chat('LittleOne42', 'Merlin build me a house'),
      seen('LittleOne42')
    )
    expect(reply?.action).toBeUndefined()
    // This test bot works no magic, so it speaks of the court's builders, not of a spellbook.
    expect(reply?.say).toContain("beyond the court's builders")
    expect(reply?.say).toContain('a simple castle')
    expect(calls[0].at(-1)?.content).toContain('You only know how to build')
  })

  describe('the Castellan', () => {
    const staff = [
      { name: 'Festaris', role: 'Castellan', canBuild: false },
      { name: 'Henry', role: 'apprentice', canBuild: true, reportsTo: 'Festaris' },
      { name: 'George', role: 'apprentice', canBuild: true, reportsTo: 'Festaris' },
    ]
    const castellan = (reply: string, commissions = new CommissionBook()) => {
      const calls: ChatMessage[][] = []
      const model: ChatModel = {
        chat: async (messages) => {
          if (messages[0].content.startsWith('You help'))
            return { message: { role: 'assistant', content: JSON.stringify(NO_ORDER) } } as never
          calls.push(messages)
          return { message: { role: 'assistant', content: reply } } as never
        },
      }
      const base = defaultBotConfig()
      const cfg = { ...base, name: 'Festaris', role: 'Castellan', canBuild: false }
      const brain = new OllamaBrain(cfg, model, court, createLogger('test'), { staff, commissions })
      return { brain, calls, commissions }
    }
    const at = (...names: string[]) => ({ ...seen(...names), botName: 'Festaris' })

    it('hands a build to his apprentices instead of declining it', async () => {
      const { brain, calls } = castellan('I shall have George plant it for you, Your Highness.')
      const reply = await brain.onChat(
        chat('LittleOne42', 'festaris could you please build a flower garden'),
        at('LittleOne42')
      )
      expect(reply?.action).toMatchObject({
        type: 'commission',
        blueprint: 'garden',
        requestedBy: 'LittleOne42',
      })
      // His answer stands: handing it on is no empty promise.
      expect(reply?.say).toBe('I shall have George plant it for you, Your Highness.')
      expect(calls[0].at(-1)?.content).toContain('Henry or George will build a flower garden')
    })

    it('says truthfully how each build stands, and that one never asked for is not begun', () => {
      const { brain, commissions } = castellan('unused')
      expect(brain.systemPrompt(at('BigDad'))).toContain('Nobody has asked you for a build lately')
      const c = commissions.add({
        blueprint: 'garden',
        title: 'a flower garden',
        palette: DEFAULT_PALETTE,
        requestedBy: 'LittleOne42',
        takenBy: 'Festaris',
        own: false,
        near: { x: 1, y: 70, z: 2 },
      })
      expect(brain.systemPrompt(at('BigDad'))).toContain(
        'a flower garden for the Princess: not started; it waits for a free builder'
      )
      commissions.start(c.id, 'George')
      expect(brain.systemPrompt(at('BigDad'))).toContain(
        'a flower garden for the Princess: George is building it right now'
      )
      commissions.finish(c.id, { ok: true })
      expect(brain.systemPrompt(at('BigDad'))).toContain(
        'a flower garden for the Princess: finished by George just now'
      )
    })

    it('takes an order for a new palace, wherever the King wants it', async () => {
      const { brain, calls } = castellan('A new palace it shall be, Your Majesty!')
      const here = await brain.onChat(
        chat('BigDad', 'Festaris, please build us a palace right here'),
        at('BigDad')
      )
      expect(here?.action).toEqual({ type: 'works', what: 'palace', requestedBy: 'BigDad' })
      expect(calls[0].at(-1)?.content).toContain('right where the King stands')
      const there = await brain.onChat(
        chat('BigDad', 'Festaris build a new castle at 400 -250'),
        at('BigDad')
      )
      expect(there?.action).toEqual({
        type: 'works',
        what: 'castle',
        requestedBy: 'BigDad',
        at: { x: 400, z: -250 },
      })
    })

    it('in survival promises no build, palace or undo, and says why', async () => {
      // What the chat model really said in the test world, against the note.
      const { brain, calls } = castellan(
        'Your Majesty, I shall make it so; I shall have the flower garden begun at once for you.'
      )
      const survival = (name: string) => ({ ...at(name), gameMode: 'survival' as const })
      const reply = await brain.onChat(
        chat('LittleOne42', 'festaris could you please build a flower garden'),
        survival('LittleOne42')
      )
      expect(reply?.action).toBeUndefined()
      expect(reply?.say).toContain('gathered and laid by hand')
      expect(calls[0].at(-1)?.content).toContain('only knows building by creative magic')
      const palace = await brain.onChat(
        chat('BigDad', 'Festaris, please build us a palace right here'),
        survival('BigDad')
      )
      expect(palace?.action).toBeUndefined()
      const prompt = brain.systemPrompt(survival('BigDad'))
      expect(prompt).toContain('This world is in survival mode')
      expect(prompt).not.toContain('The court builds wherever')
    })
  })

  it('does not keep the note in the stored history', async () => {
    const { brain, calls } = makeBrain('Alas, my spellbook does not hold that.')
    await brain.onChat(chat('LittleOne42', 'build me a house'), ctx('LittleOne42'))
    await brain.onChat(chat('LittleOne42', 'ok'), ctx('LittleOne42'))
    const history = calls[1].map((m) => m.content).join('\n')
    expect(history).toContain('build me a house')
    expect(history).not.toContain('Note for Merlin')
  })

  it('reports a finished build proudly, and a missing site kindly', async () => {
    const { brain, calls } = makeBrain('Behold!')
    const done = { title: 'a simple castle', requestedBy: 'BigDad', placed: 300, total: 300 }
    expect(await brain.onBuildDone({ ...done, ok: true }, seen('BigDad'))).toBe('Behold!')
    expect(calls[0].at(-1)?.content).toContain('You finished building a simple castle for the King')
    await brain.onBuildDone({ ...done, ok: false, placed: 0, reason: 'no_site' }, seen('BigDad'))
    expect(calls[1].at(-1)?.content).toContain('found none')
  })

  it('reports a build taken down as gone, not as raised', async () => {
    const { brain, calls } = makeBrain('It is gone, Your Majesty.')
    const undone = { title: 'a little tower', requestedBy: 'BigDad', placed: 55, total: 55 }
    await brain.onBuildDone({ ...undone, ok: true, undone: true }, seen('BigDad'))
    const asked = calls[0].at(-1)?.content ?? ''
    expect(asked).toContain('You took down a little tower for the King')
    expect(asked).not.toContain('finished building')
  })

  it('comforts a royal who died, naming the title instead of the player name', async () => {
    const { brain, calls } = makeBrain('Fear not, Your Highness, try again!')
    const event: ChatEvent = {
      from: 'server',
      message: 'LittleOne42 was slain by Zombie',
      kind: 'system',
      receivedAt: Date.now(),
      notice: { key: 'death.attack.mob', params: ['LittleOne42', 'Zombie'] },
    }
    expect(await brain.onNotice(event, ctx('LittleOne42'))).toBe(
      'Fear not, Your Highness, try again!'
    )
    const last = calls[0].at(-1)?.content ?? ''
    expect(last).toContain('the Princess was slain by Zombie')
    expect(last).toContain('Comfort the Princess')
    // The same kind of notice right after is not answered again.
    expect(await brain.onNotice(event, ctx('LittleOne42'))).toBeNull()
  })

  it('ignores notices about guests and notices it does not react to', async () => {
    const { brain, model } = makeBrain('unused')
    const notice = (key: string, who: string): ChatEvent => ({
      from: 'server',
      message: `${who} did something`,
      kind: 'system',
      receivedAt: Date.now(),
      notice: { key, params: [who] },
    })
    expect(await brain.onNotice(notice('death.attack.mob', 'Stranger'), ctx())).toBeNull()
    expect(
      await brain.onNotice(notice('multiplayer.player.joined', 'LittleOne42'), ctx())
    ).toBeNull()
    expect(model.chat).not.toHaveBeenCalled()
  })

  it('learns lasting facts from a royal conversation and uses them later', async () => {
    const memory = new CourtMemory()
    const isExtraction = (messages: ChatMessage[]) =>
      messages[0].content.startsWith('You keep the long-term memory')
    const { brain, calls } = makeBrain(
      (messages) =>
        isExtraction(messages)
          ? JSON.stringify({
              facts: [
                { about: 'the Princess', fact: 'The Princess loves magenta and periwinkle.' },
                { about: 'Merlin', fact: "Merlin's bed should be purple." },
                { about: 'the Princess', fact: 'The Princess is 7 years old.' },
                { about: 'someone else', fact: 'Ignored.' },
              ],
            })
          : 'Magenta is a splendid choice, Your Highness.',
      {},
      new HailLog(),
      { memory }
    )
    await brain.onChat(chat('LittleOne42', 'I love magenta and periwinkle'), ctx('LittleOne42'))
    await brain.settled()

    expect(memory.facts('LittleOne42')).toEqual(['The Princess loves magenta and periwinkle.'])
    expect(memory.facts('Merlin')).toEqual(["Merlin's bed should be purple."])
    const extraction = calls.find(isExtraction)
    expect(extraction?.[1].content).toContain('LittleOne42 (the Princess): I love magenta')

    const prompt = brain.systemPrompt(ctx('LittleOne42'))
    expect(prompt).toContain('About the Princess:\n- The Princess loves magenta and periwinkle.')
    expect(prompt).toContain("About yourself:\n- Merlin's bed should be purple.")
  })

  it('writes down a whole exchange, with the answer another courtier gave', async () => {
    const memory = new CourtMemory()
    const isExtraction = (messages: ChatMessage[]) =>
      messages[0].content.startsWith('You keep the long-term memory')
    const { brain, calls } = makeBrain(
      () =>
        JSON.stringify({
          facts: [
            {
              about: 'Bruce',
              fact: "Bruce is the godfather of the Princess's baby, Luna.",
              private: false,
            },
            { about: 'the Princess', fact: "The Princess's baby is called Luna.", private: false },
          ],
        }),
      {},
      new HailLog(),
      {
        memory,
        staff: [
          { name: 'Bruce', role: 'guard', canBuild: false },
          { name: 'Dyke', role: 'guard', canBuild: false },
        ],
      }
    )
    const floorTaken = { ...ctx('LittleOne42'), mayReply: false }
    await brain.onChat(
      chat('LittleOne42', 'bruce you are the godfather of my baby luna'),
      floorTaken
    )
    brain.onCourtLine(chat('Bruce', 'It would be my honour, Your Highness.'), ctx('LittleOne42'))
    brain.onCourtLine(chat('Stranger', 'Not a courtier.'), ctx('LittleOne42'))
    brain.onCourtLine(chat('Dyke', 'Too far away to be heard.'), {
      ...ctx('LittleOne42'),
      hears: false,
    })
    await brain.settled()

    const extraction = calls.filter(isExtraction)
    expect(extraction).toHaveLength(1)
    const asked = extraction[0][1].content ?? ''
    expect(asked).toContain('LittleOne42 (the Princess): bruce you are the godfather')
    expect(asked).toContain('Bruce: It would be my honour')
    expect(asked).not.toContain('Not a courtier')
    expect(asked).not.toContain('Too far away')
    expect(memory.facts('Bruce')).toEqual(["Bruce is the godfather of the Princess's baby, Luna."])
    // Merlin knows it too: his fellows' facts are in his prompt.
    expect(brain.systemPrompt(ctx('LittleOne42'))).toContain(
      "About Bruce:\n- Bruce is the godfather of the Princess's baby, Luna."
    )
  })

  it('keeps real-life facts out of the prompt while a guest is online', () => {
    const memory = new CourtMemory()
    memory.add('LittleOne42', [
      { text: 'The Princess has a big brother called Sam.', private: true },
      'The Princess loves magenta.',
    ])
    const { brain } = makeBrain('unused', {}, new HailLog(), { memory })
    const family = brain.systemPrompt(ctx('LittleOne42', 'BigDad'))
    expect(family).toContain('- The Princess has a big brother called Sam. (private)')
    expect(family).toContain('Facts marked (private) are about real life')
    const withGuest = brain.systemPrompt(ctx('LittleOne42', 'Stranger'))
    expect(withGuest).toContain('- The Princess loves magenta.')
    expect(withGuest).not.toContain('Sam')
    expect(withGuest).not.toContain('(private)')
  })

  it('does not learn what it did not hear, or from guests', async () => {
    const { brain: farAway, model: m1 } = makeBrain('Hi.')
    const unheard = { ...ctx('LittleOne42'), mayReply: false, hears: false }
    await farAway.onChat(chat('LittleOne42', 'I love cats'), unheard)
    await farAway.settled()
    expect(m1.chat).not.toHaveBeenCalled()

    const { brain, model: m2 } = makeBrain('Hi.')
    await brain.onChat(chat('Stranger', 'Merlin, I love cats'), ctx('Stranger'))
    await brain.settled()
    expect(m2.chat).toHaveBeenCalledTimes(1)
  })

  it('keeps a secret it was whispered, and is told to keep it', async () => {
    const memory = new CourtMemory()
    const isExtraction = (messages: ChatMessage[]) =>
      messages[0].content.startsWith('You keep the long-term memory')
    const { brain, calls } = makeBrain(
      (messages) =>
        isExtraction(messages)
          ? JSON.stringify({
              facts: [
                {
                  about: 'the Princess',
                  fact: 'The Princess hid a diamond under the old oak.',
                  private: false,
                  secret: true,
                },
              ],
            })
          : 'Your secret is safe with me, Your Highness.',
      {},
      new HailLog(),
      { memory }
    )
    const whisper = {
      ...chat('LittleOne42', 'i hid a diamond under the old oak'),
      kind: 'whisper' as const,
    }
    await brain.onChat(whisper, ctx('LittleOne42'))
    await brain.settled()
    const asked = calls.find(isExtraction)?.[1].content ?? ''
    expect(asked).toContain('(whispered to Merlin alone) LittleOne42 (the Princess): i hid')
    expect(calls.find(isExtraction)?.[0].content).toContain('Mark a fact secret')
    const prompt = brain.systemPrompt(ctx('LittleOne42'))
    expect(prompt).toContain('- The Princess hid a diamond under the old oak. (secret)')
    expect(prompt).toContain('Never tell them to anyone')
  })

  describe('orders', () => {
    const order = (summary: string, extra: Partial<Reading> = {}): Partial<Reading> => ({
      type: 'order',
      forMe: true,
      summary,
      lasting: true,
      ...extra,
    })

    it("declines the Princess's order when it clashes with the King's, and says why", async () => {
      const orders = new OrderBook()
      orders.add({
        from: 'BigDad',
        by: 'the King',
        text: 'Stay by the gate.',
        post: { type: 'stay' },
      })
      const { brain, calls, readings } = makeBrain(
        'I must stay, Your Highness.',
        {},
        new HailLog(),
        {
          orders,
        }
      )
      readings.push(order('Follow the Princess.', { clashes: ['O1'] }))
      const reply = await brain.onChat(chat('LittleOne42', 'Merlin follow me'), seen('LittleOne42'))
      expect(reply).toEqual({ say: 'I must stay, Your Highness.' })
      const note = calls[0].at(-1)?.content ?? ''
      expect(note).toContain('your standing order from the King: "Stay by the gate."')
      expect(note).toContain('Politely decline')
      expect(orders.orders.map((o) => o.text)).toEqual(['Stay by the gate.'])
    })

    it('asks the King to confirm a clashing order, and carries it out on "yes"', async () => {
      const orders = new OrderBook()
      orders.add({
        from: 'LittleOne42',
        by: 'the Princess',
        text: 'Follow the Princess.',
        post: { type: 'follow', target: 'LittleOne42' },
      })
      const { brain, calls, readings } = makeBrain('Very well, Your Majesty.', {}, new HailLog(), {
        orders,
      })
      readings.push(order('Follow the King.', { clashes: ['O1'] }))
      const asked = await brain.onChat(
        chat('BigDad', 'Merlin follow me'),
        seen('BigDad', 'LittleOne42')
      )
      expect(asked?.action).toBeUndefined()
      expect(calls[0].at(-1)?.content).toContain('ask the King to confirm')

      const confirmed = await brain.onChat(chat('BigDad', 'yes'), seen('BigDad', 'LittleOne42'))
      expect(confirmed?.action).toEqual({ type: 'follow', target: 'BigDad' })
      expect(calls[1].at(-1)?.content).toContain('the King confirmed it')
      expect(orders.orders.map((o) => o.text)).toEqual(['Follow the King.'])
      expect(brain.post()).toEqual({ type: 'follow', target: 'BigDad' })
    })

    it('keeps a rule for the whole court and shows it in every prompt', async () => {
      const rules = new CourtRules()
      const { brain, readings } = makeBrain('So it shall be.', {}, new HailLog(), { rules })
      readings.push({ type: 'rule', summary: "Nobody may enter the Princess's bedchamber." })
      await brain.onChat(chat('BigDad', 'from now on nobody goes into her bedroom'), ctx('BigDad'))
      expect(rules.rules.map((r) => r.text)).toEqual([
        "Nobody may enter the Princess's bedchamber.",
      ])
      const other = makeBrain('unused', {}, new HailLog(), { rules }).brain
      expect(other.systemPrompt(ctx('BigDad'))).toContain(
        "- Nobody may enter the Princess's bedchamber. (the King)"
      )
    })

    it('lets the King release an order, but not the Princess', async () => {
      const orders = new OrderBook()
      orders.add({
        from: 'BigDad',
        by: 'the King',
        text: 'Stay by the gate.',
        post: { type: 'stay' },
      })
      const { brain, calls, readings } = makeBrain('Hm.', {}, new HailLog(), { orders })
      readings.push({ type: 'release', forMe: true, releases: ['O1'] })
      await brain.onChat(chat('LittleOne42', 'merlin you can go now'), ctx('LittleOne42'))
      expect(calls[0].at(-1)?.content).toContain('That is not theirs to end')
      expect(orders.orders).toHaveLength(1)

      readings.push({ type: 'release', forMe: true, releases: ['O1'] })
      await brain.onChat(chat('BigDad', 'merlin you can go now'), ctx('BigDad'))
      expect(orders.orders).toHaveLength(0)
      expect(brain.post()).toBeUndefined()
    })

    it('stays put on "stay here", and owes its superior a report', async () => {
      const orders = new OrderBook()
      const base = defaultBotConfig()
      const cfg = { ...base, name: 'Henry', role: 'apprentice', reportsTo: 'Festaris' }
      const model: ChatModel = {
        chat: async (messages) =>
          ({
            message: {
              role: 'assistant',
              content: messages[0].content.startsWith('You help')
                ? JSON.stringify({ ...NO_ORDER, ...order('Stay here.') })
                : 'I shall not move, Your Majesty.',
            },
          }) as never,
      }
      const brain = new OllamaBrain(cfg, model, court, createLogger('test'), { orders })
      const reply = await brain.onChat(chat('BigDad', 'Henry stay here'), {
        ...ctx('BigDad'),
        botName: 'Henry',
      })
      expect(reply?.action).toEqual({ type: 'stay' })
      expect(brain.post()).toEqual({ type: 'stay' })
      expect(brain.pendingReports()).toEqual(['the King gave me an order: Stay here.'])
    })

    it('a bot named alongside the one who answers takes the order quietly', async () => {
      const { brain, calls, readings } = makeBrain('unused')
      readings.push(order('Follow the Princess.'))
      const floorTaken = { ...seen('LittleOne42'), mayReply: false }
      const reply = await brain.onChat(
        chat('LittleOne42', 'Bruce and Merlin follow me'),
        floorTaken
      )
      expect(reply).toEqual({ say: null, action: { type: 'follow', target: 'LittleOne42' } })
      expect(calls).toHaveLength(0)
    })

    it('casts a spell a royal asks for, and says when its magic is still gathering', async () => {
      const magic = new Magic()
      const { brain, calls, readings } = makeBrain('Behold!', {}, new HailLog(), { magic })
      const sparkles = { spells: [{ id: 'sparkles', target: 'speaker' }], lasting: false }
      readings.push(order('Cast sparkles on the Princess.', sparkles))
      const reply = await brain.onChat(
        chat('LittleOne42', 'merlin make sparkles'),
        ctx('LittleOne42')
      )
      expect(reply?.action).toEqual({
        type: 'cast',
        casts: [{ spell: 'sparkles', args: {}, target: 'LittleOne42' }],
        requestedBy: 'LittleOne42',
      })
      expect(calls[0].at(-1)?.content).toContain(
        'You cast now, in this order: Sparkles on the Princess'
      )
      expect(brain.systemPrompt(ctx('LittleOne42'))).toContain('- You work magic: Blink, Summoning')

      const ok = async () => ({ ok: true, count: 1, output: [] })
      const spell = magic.find('sparkles')!
      const who = { requester: 'LittleOne42', target: 'LittleOne42', merlin: 'Merlin' }
      await magic.cast(spell, {}, who, ok)
      readings.push(order('Cast sparkles on the Princess.', sparkles))
      const again = await brain.onChat(chat('LittleOne42', 'again!'), ctx('LittleOne42'))
      expect(again?.action).toBeUndefined()
      expect(calls[1].at(-1)?.content).toContain('still gathering')
    })

    it('casts several spells in the order asked: both of us to the castle, then the court', async () => {
      const { brain, calls, readings } = makeBrain('Hold on!', {}, new HailLog(), {
        magic: new Magic({
          places: () => [{ name: 'the great hall of the Great Castle', x: 1, y: 2, z: 3 }],
        }),
      })
      const hall = 'the great hall of the Great Castle'
      readings.push(
        order('Take the King and Merlin to the castle, then gather the court.', {
          lasting: false,
          spells: [
            { id: 'portal', target: 'speaker', place: hall },
            { id: 'portal', target: 'Merlin', place: hall },
            { id: 'gather', target: 'speaker' },
          ],
        })
      )
      const reply = await brain.onChat(
        chat('BigDad', 'take us both to the castle and summon the court'),
        ctx('BigDad')
      )
      expect(reply?.action).toEqual({
        type: 'cast',
        casts: [
          { spell: 'portal', args: { place: hall }, target: 'BigDad' },
          { spell: 'portal', args: { place: hall }, target: 'Merlin' },
          { spell: 'gather', args: {}, target: 'BigDad' },
        ],
        requestedBy: 'BigDad',
      })
      const note = calls[0].at(-1)?.content ?? ''
      expect(note).toContain('Portal on the King (to the great hall of the Great Castle)')
      expect(note).toContain('Portal on yourself')
    })

    it('will not work magic on a royal who outranks the one asking', async () => {
      const { brain, calls, readings } = makeBrain('Alas.', {}, new HailLog(), {
        magic: new Magic(),
      })
      readings.push(
        order('Make the King float.', { spells: [{ id: 'float', target: 'the King' }] })
      )
      const reply = await brain.onChat(
        chat('LittleOne42', 'merlin make daddy float'),
        ctx('LittleOne42')
      )
      expect(reply?.action).toBeUndefined()
      expect(calls[0].at(-1)?.content).toContain('outranks the Princess, and needs their own wish')
    })

    it('learns a spell the King teaches once he confirms it, and only from the King', async () => {
      const magic = new Magic()
      const { brain, calls, readings } = makeBrain('So be it.', {}, new HailLog(), { magic })
      const teach = {
        type: 'teach' as const,
        teach: {
          name: 'Starfall',
          does: 'Fireworks rain around the one it is cast on.',
          steps: [{ kind: 'summon', creature: 'fireworks_rocket', at: 'target', count: 3 }],
        },
      }
      readings.push(teach)
      await brain.onChat(chat('LittleOne42', 'merlin learn starfall'), ctx('LittleOne42'))
      expect(calls[0].at(-1)?.content).toContain('Only the King may teach you')

      readings.push(teach)
      await brain.onChat(chat('BigDad', 'Merlin, a new spell: starfall'), ctx('BigDad'))
      expect(calls[1].at(-1)?.content).toContain('ask the King to confirm before you learn it')
      expect(magic.find('starfall')).toBeUndefined()
      await brain.onChat(chat('BigDad', 'yes'), ctx('BigDad'))
      expect(magic.find('starfall')?.learnedFrom).toBe('the King')
      expect(calls[2].at(-1)?.content).toContain('You have learned the spell "Starfall"')
    })

    it('does not read lines for orders that are not meant for it', async () => {
      const { brain, reads } = makeBrain('unused')
      await brain.onChat(chat('LittleOne42', 'Bruce follow me'), {
        ...ctx('LittleOne42'),
        mayReply: false,
      })
      expect(reads).toHaveLength(0)
    })
  })

  it('knows the chain of command: who reports to whom', () => {
    const staff = [
      { name: 'Merlin', role: 'court wizard', canBuild: true },
      { name: 'Festaris', role: 'Castellan', canBuild: false },
      { name: 'Henry', role: 'apprentice', canBuild: true, reportsTo: 'Festaris' },
    ]
    const brainOf = (name: string, reportsTo?: string) => {
      const base = defaultBotConfig()
      const cfg = { ...base, name, ...(reportsTo ? { reportsTo } : {}) }
      return new OllamaBrain(cfg, { chat: vi.fn() }, court, createLogger('test'), { staff })
    }
    const prompt = (name: string, reportsTo?: string) =>
      brainOf(name, reportsTo).systemPrompt({ ...ctx('LittleOne42'), botName: name })

    const merlin = prompt('Merlin')
    expect(merlin).toContain('You answer to the royal family alone. Nobody else at court')
    expect(merlin).toContain('Henry (apprentice, reports to Festaris)')
    expect(merlin).toContain('Festaris (Castellan, answers to the royal family)')
    expect(prompt('Festaris')).toContain('Henry report to you: you give them their tasks')
    expect(prompt('Henry', 'Festaris')).toContain('You report to Festaris: you take orders')
  })

  it('puts the court and the safety rules in the system prompt', () => {
    const { brain } = makeBrain('unused')
    const prompt = brain.systemPrompt({
      botName: 'Merlin',
      players: [{ name: 'LittleOne42', distance: 12.4 }],
      position: { x: 127.5, y: 71.6, z: 98.5 },
    })
    expect(prompt).toContain('Your exact position is x 128, y 72, z 99')
    expect(prompt).toContain('Never invent places')
    expect(prompt).toContain('LittleOne42 is the Princess')
    expect(prompt).toContain('the Princess (LittleOne42), 12 blocks away')
    expect(prompt).toContain('suitable for a young child')
    expect(prompt).toContain('Never ask anyone for personal information')
    expect(prompt).not.toMatch(/\n\n\n/)
  })
})
