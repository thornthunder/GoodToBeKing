import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CastleDesign } from '../build/design'
import { Magic, type CommandResult } from './Magic'
import { castlePlaces } from './places'
import {
  BUILTIN_SPELLS,
  commandsFor,
  cooldownOf,
  spellProblems,
  tidySteps,
  type Spell,
} from './spells'

const spell = (id: string): Spell => BUILTIN_SPELLS.find((s) => s.id === id)!
const ctx = {
  requester: 'LittleOne42',
  target: 'LittleOne42',
  merlin: 'Merlin',
  court: ['Bruce', 'Dyke'],
  placeOf: (name: string | undefined) =>
    name === 'the throne room of the Great Castle' ? { x: 101, y: 79, z: 106 } : undefined,
  args: {},
  giftId: '7',
}

describe('spells', () => {
  it('builds the commands from the spell, never from free text', () => {
    expect(commandsFor(spell('blink'), ctx).map((c) => c.command)).toEqual([
      'tp "Merlin" "LittleOne42"',
    ])
    expect(
      commandsFor(spell('portal'), {
        ...ctx,
        args: { place: 'the throne room of the Great Castle' },
      }).map((c) => c.command)
    ).toEqual(['tp "LittleOne42" 101.5 79 106.5'])
    expect(commandsFor(spell('gather'), ctx).map((c) => c.command)).toEqual([
      'tp "Bruce" "LittleOne42"',
      'tp "Dyke" "LittleOne42"',
    ])
    expect(commandsFor(spell('night_sight'), ctx)[0].command).toBe(
      'effect "LittleOne42" night_vision 300 0 true'
    )
    expect(commandsFor(spell('fair_weather'), ctx)[0].command).toBe('weather clear')
  })

  it('refuses what is not on the allowlists', () => {
    expect(() =>
      commandsFor(spell('summon_creature'), { ...ctx, args: { creature: 'creeper' } })
    ).toThrow('no such creature')
    expect(() => commandsFor(spell('gift'), { ...ctx, args: { item: 'diamond' } })).toThrow(
      'not a gift'
    )
    expect(() => commandsFor(spell('portal'), { ...ctx, args: { place: 'the moon' } })).toThrow(
      'not known'
    )
  })

  it('gives a gift with the way to take it back, and saddles only an unsaddled horse', () => {
    const [give] = commandsFor(spell('gift'), { ...ctx, args: { item: 'cake' } })
    expect(give).toEqual({
      command: 'give "LittleOne42" cake 1',
      undo: ['clear "LittleOne42" cake -1 1'],
    })
    const [find, saddle] = commandsFor(spell('saddle'), ctx)
    expect(find.command).toContain('hasitem={item=saddle,quantity=0}] add merlin_gift_7')
    expect(saddle.undo).toEqual([
      'replaceitem entity @e[tag=merlin_gift_7] slot.inventory 0 air',
      'event entity @e[tag=merlin_gift_7] minecraft:horse_unsaddled',
      'tag @e[tag=merlin_gift_7] remove merlin_gift_7',
    ])
  })

  it('teleports are free, everything else needs a while', () => {
    expect(cooldownOf(spell('blink'))).toBe(0)
    expect(cooldownOf(spell('gather'))).toBe(0)
    expect(cooldownOf(spell('heal'))).toBe(2 * 60_000)
    expect(cooldownOf(spell('gift'))).toBe(10 * 60_000)
    expect(cooldownOf(spell('fireworks'))).toBe(30_000)
  })

  it('tidies a spell the model squeezed into one step', () => {
    // As gemma4:31b wrote Starfall: three fireworks with a twinkle, all in one summon step.
    const steps = tidySteps([
      {
        kind: 'summon',
        creature: 'fireworks_rocket',
        count: 3,
        particle: 'minecraft:heart_particle',
        sound: 'firework.twinkle',
        item: 'firework_rocket',
      },
    ])
    expect(steps).toEqual([
      { kind: 'summon', at: 'target', count: 3, creature: 'fireworks_rocket' },
      { kind: 'particle', particle: 'minecraft:heart_particle', at: 'target' },
      { kind: 'sound', sound: 'firework.twinkle', at: 'target' },
    ])
    expect(spellProblems(steps)).toEqual([])
  })

  it('checks a taught spell against the allowlists', () => {
    expect(
      spellProblems([
        { kind: 'summon', creature: 'cat', at: 'target', count: 2 },
        { kind: 'effect', who: 'target', effect: 'levitation', seconds: 3 },
      ])
    ).toEqual([])
    const bad = spellProblems([
      { kind: 'summon', creature: 'wither', at: 'target', count: 1 },
      { kind: 'effect', who: 'target', effect: 'levitation', seconds: 60 },
      { kind: 'fill', blocks: 'tnt' },
    ])
    expect(bad).toHaveLength(3)
    expect(bad[2]).toContain('no magic of the kind "fill"')
  })
})

describe('the magic keeper', () => {
  const ran: string[] = []
  const ok = async (command: string): Promise<CommandResult> => {
    ran.push(command)
    return { ok: true, count: 1, output: [] }
  }

  it('casts, starts the cooldown, and keeps gifts until their day is over', async () => {
    const magic = new Magic({ court: ['Merlin', 'Bruce'] })
    const who = { requester: 'LittleOne42', target: 'LittleOne42', merlin: 'Merlin' }
    const t0 = 1_000_000
    expect(await magic.cast(spell('gift'), { item: 'cake' }, who, ok, t0)).toEqual({ ok: true })
    expect(magic.wait(spell('gift'), t0 + 60_000)).toBe(9 * 60_000)
    expect(magic.pendingGifts).toHaveLength(1)

    const online = () => true
    expect(magic.due(online, t0 + 60_000)).toHaveLength(0)
    const [gift] = magic.due(online, t0 + 24 * 3_600_000)
    expect(await magic.takeBack(gift, ok, t0 + 24 * 3_600_000)).toBe(true)
    expect(ran.at(-1)).toBe('clear "LittleOne42" cake -1 1')
    expect(magic.pendingGifts).toHaveLength(0)
  })

  it('says why a spell failed', async () => {
    const magic = new Magic()
    const refused = async (): Promise<CommandResult> => ({
      ok: false,
      count: 0,
      output: ['commands.generic.disabled'],
    })
    const who = { requester: 'LittleOne42', target: 'LittleOne42', merlin: 'Merlin' }
    const result = await magic.cast(spell('fair_weather'), {}, who, refused)
    expect(result.reason).toContain('commands.generic.disabled')
    const saddle = await magic.cast(spell('saddle'), {}, who, refused)
    expect(saddle.reason).toContain('no horse without a saddle')

    // The horse was found and marked, but would not take the saddle (a wild horse).
    const ran: string[] = []
    const wild = async (command: string): Promise<CommandResult> => {
      ran.push(command)
      return {
        ok:
          !command.startsWith('replaceitem entity @e[tag=merlin_gift_') || command.endsWith('air'),
        count: 1,
        output: [],
      }
    }
    const untamed = await magic.cast(spell('saddle'), {}, who, wild)
    expect(untamed.reason).toBe('the horse next to LittleOne42 is not tame yet')
    expect(ran.at(-1)).toMatch(/^tag @e\[tag=merlin_gift_\d+\] remove/)
    expect(magic.pendingGifts).toHaveLength(0)
  })

  it('learns a spell with a fixed place, under a name of its own', () => {
    const magic = new Magic({
      places: () => [{ name: 'the chapel of the Great Castle', x: 1, y: 2, z: 3 }],
    })
    const learned = magic.learn(
      {
        name: 'Chapel Bells',
        does: 'Sends the one it is cast on to the chapel with a chime.',
        steps: [
          { kind: 'teleport', who: 'target', to: 'the chapel of the Great Castle' as never },
          { kind: 'sound', sound: 'random.orb', at: 'target' },
        ],
      },
      'the King'
    )
    expect(learned.id).toBe('chapel_bells')
    expect(learned.steps[0]).toEqual({
      kind: 'teleport',
      who: 'target',
      to: { place: 'the chapel of the Great Castle' },
    })
    expect(magic.find('Chapel Bells')?.learnedFrom).toBe('the King')
  })
})

describe('places', () => {
  it('finds a free spot in every room of the castle', () => {
    const great = JSON.parse(
      fs.readFileSync('config/castles/great-castle.json', 'utf8')
    ) as CastleDesign
    const places = castlePlaces([great])
    const names = places.map((p) => p.name)
    expect(names).toContain('the throne room of the Great Castle')
    expect(names).toContain("the Princess's bedchamber of the Great Castle")
    expect(names).toContain('the courtyard of the Great Castle')
    for (const p of places) expect(p.y).toBeGreaterThan(great.floorY)
  })
})
