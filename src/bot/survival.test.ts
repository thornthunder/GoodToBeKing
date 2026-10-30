import { describe, expect, it } from 'vitest'
import { duskFallen, HOSTILE, isNight, outdoorHours } from './survival'

describe('survival', () => {
  it('sends nobody out late in the day, and calls everyone in at dusk', () => {
    expect(outdoorHours(2_000)).toBe(true)
    // An errand begun at 10 000 would still be out when the monsters come.
    expect(outdoorHours(10_000)).toBe(false)
    // At first light the night's monsters are still about.
    expect(outdoorHours(23_900)).toBe(false)
    expect(duskFallen(11_000)).toBe(false)
    expect(duskFallen(12_000)).toBe(true)
    expect(duskFallen(100 + 24_000 * 3)).toBe(true)
  })

  it('knows night from day, whatever day it is', () => {
    expect(isNight(6_000)).toBe(false)
    expect(isNight(13_000)).toBe(true)
    expect(isNight(18_000 + 24_000 * 5)).toBe(true)
    expect(isNight(23_900)).toBe(false)
    expect(isNight(undefined)).toBe(false)
  })

  it('fights monsters, but leaves creepers, endermen and the animals alone', () => {
    for (const foe of ['zombie', 'skeleton', 'spider', 'husk', 'drowned'])
      expect(HOSTILE.test(foe)).toBe(true)
    for (const other of ['creeper', 'enderman', 'phantom', 'cow', 'villager', 'player'])
      expect(HOSTILE.test(other)).toBe(false)
  })
})
