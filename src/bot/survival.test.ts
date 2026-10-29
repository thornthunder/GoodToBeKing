import { describe, expect, it } from 'vitest'
import { HOSTILE, isNight } from './survival'

describe('survival', () => {
  it('knows night from day, whatever day it is', () => {
    expect(isNight(6_000)).toBe(false)
    expect(isNight(13_000)).toBe(true)
    expect(isNight(18_000 + 24_000 * 5)).toBe(true)
    expect(isNight(23_900)).toBe(false)
    expect(isNight(undefined)).toBe(false)
  })

  it('fights monsters, but leaves creepers, endermen and the animals alone', () => {
    for (const foe of ['zombie', 'skeleton', 'spider', 'husk', 'drowned', 'phantom'])
      expect(HOSTILE.test(foe)).toBe(true)
    for (const other of ['creeper', 'enderman', 'cow', 'villager', 'player', 'wolf'])
      expect(HOSTILE.test(other)).toBe(false)
  })
})
