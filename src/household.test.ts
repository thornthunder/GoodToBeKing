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

  it('moves house: the field, mine and grove start afresh, the old storehouse is carried over', () => {
    const h = new Household()
    h.setHome({ x: 0, y: 64, z: 0 }, 'BigDad')
    h.setStorehouse({ x: 2, y: 64, z: 1 }, 'BigDad')
    h.noteStock({ oak_log: 12 })
    h.setFarm({ y: 63, cells: [[5, 5]], watered: false })
    h.setMine({ x: 10, y: 64, z: 0, dx: 1, dz: 0, steps: 4 })
    h.moveHome({ x: 300, y: 70, z: -40 }, 'BigDad')
    expect(h.home).toMatchObject({ x: 300, y: 70, z: -40 })
    expect(h.farm).toBeUndefined()
    expect(h.mine).toBeUndefined()
    expect(h.storehouse).toBeUndefined()
    expect(h.formerStore).toMatchObject({ x: 2, z: 1, stock: { oak_log: 12 } })
    // Emptied: done with.
    h.noteFormerStock({ oak_log: 0 })
    expect(h.formerStore).toBeUndefined()
  })

  it("keeps the court's digging clear of the buildings round home", () => {
    const h = new Household()
    h.setHome({ x: 0, y: 64, z: 0 }, 'BigDad')
    h.setEstate([{ x: 10, z: 10, width: 20, depth: 20 }])
    const clear = h.keepClear()
    // Over the castle and the ground beside it, every few blocks.
    expect(clear).toContainEqual([6, 6])
    expect(clear.some(([x, z]) => Math.abs(x - 20) <= 2 && Math.abs(z - 20) <= 2)).toBe(true)
    expect(h.grounds().some((p) => p.x === 6 && p.z === 6)).toBe(true)
  })
})
