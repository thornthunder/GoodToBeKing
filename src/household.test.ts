import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Household } from './household'

describe('the household', () => {
  it('keeps the home, the storehouse and its stock across restarts', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'household-')), 'household.json')
    const h = new Household(file)
    expect(h.home).toBeUndefined()
    h.setHome({ x: 10.7, y: 64.2, z: -3.5 }, 'BigDad', 1)
    h.setStorehouse({ x: 12, y: 64, z: -2 }, 'BigDad', 2)
    h.noteStock({ dirt: 5, oak_log: 12, cobblestone: 0 }, 3)

    const again = new Household(file)
    expect(again.home).toEqual({ x: 10, y: 64, z: -4, setBy: 'BigDad', at: 1 })
    expect(again.storehouse).toMatchObject({ x: 12, y: 64, z: -2 })
    expect(again.stockWords()).toBe('12 oak log, 5 dirt')

    // A new chest: the old one's stock says nothing about it.
    again.setStorehouse({ x: 20, y: 64, z: 0 }, 'LittleOne42')
    expect(again.stockWords()).toBe('nothing')
  })
})
