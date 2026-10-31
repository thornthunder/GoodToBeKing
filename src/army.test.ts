import { describe, expect, it } from 'vitest'
import { bestSword, blessingSteps, materialOf, wantsBlessing } from './army'

describe('Bless the Army', () => {
  it('gives copper where a soldier has worse, iron to the leader, and keeps what is better', () => {
    const steps = blessingSteps(
      {
        Bruce: { head: 'iron', chest: 'leather', sword: 'stone', shield: false },
        Sarge: { head: 'copper', sword: 'iron', shield: true },
      },
      'Sarge'
    )
    const bruce = steps.filter((s) => s.to === 'Bruce').map((s) => s.item)
    expect(bruce).toEqual([
      'copper_chestplate',
      'copper_leggings',
      'copper_boots',
      'copper_sword',
      'shield',
    ])
    const sarge = steps.filter((s) => s.to === 'Sarge')
    expect(sarge.map((s) => s.item)).toEqual([
      'iron_helmet',
      'iron_chestplate',
      'iron_leggings',
      'iron_boots',
    ])
    expect(sarge[0].command).toBe('replaceitem entity "Sarge" slot.armor.head 0 iron_helmet')
    expect(sarge[0].undo).toBe('clear "Sarge" iron_helmet -1 1')
  })

  it('wants nothing for a soldier in diamond', () => {
    const gear = {
      head: 'diamond',
      chest: 'diamond',
      legs: 'diamond',
      feet: 'diamond',
      sword: 'diamond',
      shield: true,
    }
    expect(wantsBlessing({ Bruce: gear }, 'Sarge')).toBe(false)
  })

  it('reads materials', () => {
    expect(materialOf('copper_chestplate')).toBe('copper')
    expect(bestSword(['stone_sword', 'bread', 'iron_axe', 'wooden_sword'])).toBe('iron')
    expect(bestSword(['bread'])).toBeUndefined()
  })
})
