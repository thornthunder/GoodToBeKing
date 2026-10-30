import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CastleDesign } from '../build/design'
import { Magic, type CommandResult } from './Magic'
import { castlePlaces } from './places'
import {
  BUILTIN_SPELLS,
  castingCost,
  commandsFor,
  isTravel,
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
      items: 1,
    })
    const [find, saddle] = commandsFor(spell('saddle'), ctx)
    expect(find.command).toContain('hasitem={item=saddle,quantity=0}] add merlin_gift_7')
    expect(saddle.undo).toEqual([
      'replaceitem entity @e[tag=merlin_gift_7] slot.inventory 0 air',
      'event entity @e[tag=merlin_gift_7] minecraft:horse_unsaddled',
      'tag @e[tag=merlin_gift_7] remove merlin_gift_7',
    ])
  })

  it('travel is free; a casting counts one, and conjured things count one by one', () => {
    expect(isTravel(spell('blink'))).toBe(true)
    expect(castingCost(spell('gather'))).toBe(0)
    expect(castingCost(spell('heal'))).toBe(1)
    expect(castingCost(spell('fair_weather'))).toBe(1)
    expect(castingCost(spell('fireworks'))).toBe(1)
    expect(castingCost(spell('sparkles'))).toBe(1)
    // A gift or a creature costs what it conjures, nothing more.
    expect(castingCost(spell('gift'))).toBe(0)
    expect(castingCost(spell('summon_creature'))).toBe(0)
    const horses = commandsFor(spell('summon_creature'), {
      ...ctx,
      args: { creature: 'horse', count: 5 },
      magicLeft: 2,
    })
    // Five horses asked for, two left this hour: two come.
    expect(horses.filter((c) => c.command.includes('summon horse')).map((c) => c.items)).toEqual([
      1, 1,
    ])
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
    expect(magic.magicLeft(t0 + 60_000)).toBe(9)
    expect(magic.pendingGifts).toHaveLength(1)

    const online = () => true
    expect(magic.due(online, t0 + 60_000)).toHaveLength(0)
    const [gift] = magic.due(online, t0 + 24 * 3_600_000)
    expect(await magic.takeBack(gift, ok, t0 + 24 * 3_600_000)).toBe(true)
    expect(ran.at(-1)).toBe('clear "LittleOne42" cake -1 1')
    expect(magic.pendingGifts).toHaveLength(0)
  })

  it('does at most ten things an hour, all spells together, even after a restart', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'magic-')), 'magic.json')
    const magic = new Magic({ file })
    const who = { requester: 'LittleOne42', target: 'Henry', merlin: 'Merlin' }
    const t0 = 5_000_000
    // Twelve cookies asked for: no more than eight at once.
    expect(await magic.cast(spell('gift'), { item: 'cookie', count: 12 }, who, ok, t0)).toEqual({
      ok: true,
    })
    expect(ran.filter((c) => c.startsWith('give')).at(-1)).toBe('give "Henry" cookie 8')
    expect(magic.magicLeft(t0)).toBe(2)
    // Only two of the four loaves are left to give this hour.
    const bread = { item: 'bread', count: 4 }
    expect(await magic.cast(spell('gift'), bread, who, ok, t0 + 600_000)).toEqual({ ok: true })
    expect(ran.filter((c) => c.startsWith('give')).at(-1)).toBe('give "Henry" bread 2')
    const spentLine =
      'the magic is spent (at most 10 spells and things an hour, travel is free); it gathers again in 30 minutes'
    expect(magic.check(spell('gift'), { item: 'oak_log' }, t0 + 1_800_000)).toBe(spentLine)
    expect(magic.check(spell('fair_weather'), {}, t0 + 1_800_000)).toBe(spentLine)
    const spent = await magic.cast(spell('fair_weather'), {}, who, ok, t0 + 1_800_000)
    expect(spent.reason).toBe(spentLine)
    // Travel is free, however much magic was done.
    expect(magic.check(spell('portal'), { place: 'anywhere' }, t0 + 1_800_000)).not.toContain(
      'spent'
    )
    expect(await magic.cast(spell('gather'), {}, who, ok, t0 + 1_800_000)).toEqual({ ok: true })

    const restarted = new Magic({ file })
    expect(restarted.magicLeft(t0 + 1_800_000)).toBe(0)
    expect(restarted.magicLeft(t0 + 3_600_000)).toBe(8)
    // The weather changed once more after the cookies' hour.
    expect(await restarted.cast(spell('fair_weather'), {}, who, ok, t0 + 3_700_000)).toEqual({
      ok: true,
    })
    expect(restarted.magicLeft(t0 + 3_700_000)).toBe(7)
    expect(restarted.magicLeft(t0 + 4_200_000)).toBe(9)
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
  }, 30_000) // compiles the whole castle: slow when the suite runs in parallel
})
