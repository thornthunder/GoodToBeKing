import { Vec3 } from 'vec3'
import { describe, expect, it } from 'vitest'
import { wild, type Animal } from './hunting'

const animal = (name: string, metadata: Record<string, unknown> = {}): Animal => ({
  id: 1,
  name,
  position: new Vec3(0, 64, 0),
  metadata,
})

describe("the King's hunting rule", () => {
  it('may take a plain cow, pig, sheep, chicken or rabbit', () => {
    for (const kind of ['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
      expect(wild(animal(kind))).toBe(true)
  })

  it('never a named, tame, owned or leashed animal, nor a baby', () => {
    expect(wild(animal('cow', { nametag: 'Daisy' }))).toBe(false)
    expect(wild(animal('pig', { flags: { baby: true } }))).toBe(false)
    expect(wild(animal('sheep', { flags: { leashed: true } }))).toBe(false)
    expect(wild(animal('chicken', { flags: { tamed: true } }))).toBe(false)
    expect(wild(animal('cow', { owner_eid: 12n }))).toBe(false)
    // An empty name tag is no name.
    expect(wild(animal('cow', { nametag: '' }))).toBe(true)
  })

  it('never any kind that can be tamed, nor villagers', () => {
    for (const kind of ['horse', 'wolf', 'cat', 'parrot', 'llama', 'donkey', 'villager', 'fox'])
      expect(wild(animal(kind))).toBe(false)
  })
})
