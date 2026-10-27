import { describe, expect, it, vi } from 'vitest'
import { defaultBotConfig, type BotConfig } from '../config'
import { CourtRoster } from '../court'
import { createLogger } from '../logger'
import type { BrainContext, ChatEvent } from './Brain'
import { CourtMemory } from './CourtMemory'
import { HailLog } from './HailLog'
import { OllamaBrain, type BrainOptions } from './OllamaBrain'
import type { ChatMessage, ChatModel } from './OllamaClient'

const court = new CourtRoster({
  realm: 'Testland',
  charter: 'Serve the royal family.',
  members: [
    { player: 'LittleOne42', role: 'princess', title: 'Princess', address: 'Your Highness' },
    { player: 'BigDad', role: 'king', title: 'King', address: 'Your Majesty' },
  ],
})

type FakeReply = string | Error | ((messages: ChatMessage[]) => string)

function makeBrain(
  reply: FakeReply,
  overrides: Partial<BotConfig['chat']> = {},
  hails = new HailLog(),
  extra: Omit<BrainOptions, 'hails'> = {}
) {
  const calls: ChatMessage[][] = []
  const model: ChatModel = {
    chat: vi.fn(async (messages: ChatMessage[]) => {
      calls.push(messages)
      if (reply instanceof Error) throw reply
      const content = typeof reply === 'function' ? reply(messages) : reply
      return { message: { role: 'assistant', content } } as Awaited<ReturnType<ChatModel['chat']>>
    }),
  }
  const base = defaultBotConfig()
  const cfg: BotConfig = {
    ...base,
    name: 'Merlin',
    chat: { ...base.chat, greeting: 'Hello all', ...overrides },
  }
  const brain = new OllamaBrain(cfg, model, court, createLogger('test'), { hails, ...extra })
  return { brain, calls, model }
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

  it('offers the spellbook, and replaces a promise, for something it cannot build', async () => {
    const { brain, calls } = makeBrain('I will build you the finest house, little Princess.')
    const reply = await brain.onChat(
      chat('LittleOne42', 'Merlin build me a house'),
      seen('LittleOne42')
    )
    expect(reply?.action).toBeUndefined()
    expect(reply?.say).toContain('my spellbook does not hold that yet')
    expect(reply?.say).toContain('a simple castle')
    expect(calls[0].at(-1)?.content).toContain('Your spellbook only holds')
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
      { memory, learns: true }
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

  it('does not learn when it is not the scribe, or from guests', async () => {
    const memory = new CourtMemory()
    const { brain: notScribe, model: m1 } = makeBrain('Hi.', {}, new HailLog(), { memory })
    await notScribe.onChat(chat('LittleOne42', 'I love cats'), ctx('LittleOne42'))
    await notScribe.settled()
    expect(m1.chat).toHaveBeenCalledTimes(1)

    const { brain: scribe, model: m2 } = makeBrain('Hi.', {}, new HailLog(), {
      memory,
      learns: true,
    })
    await scribe.onChat(chat('Stranger', 'Merlin, I love cats'), ctx('Stranger'))
    await scribe.settled()
    expect(m2.chat).toHaveBeenCalledTimes(1)
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
    expect(prompt).toContain('Never ask for or repeat personal information')
    expect(prompt).not.toMatch(/\n\n\n/)
  })
})
