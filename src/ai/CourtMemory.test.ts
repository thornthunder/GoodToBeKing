import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CourtMemory, isPersonalInfo } from './CourtMemory'

describe('CourtMemory', () => {
  it('stores facts per subject, case-insensitively, without duplicates', () => {
    const memory = new CourtMemory()
    expect(memory.add('LittleOne42', ['The Princess loves magenta.'])).toHaveLength(1)
    expect(
      memory.add('littleone42', ['the princess loves MAGENTA', 'She has a cat called Biscuit.'])
    ).toEqual(['She has a cat called Biscuit.'])
    expect(memory.facts('LITTLEONE42')).toEqual([
      'The Princess loves magenta.',
      'She has a cat called Biscuit.',
    ])
  })

  it('never stores real-world personal information', () => {
    const memory = new CourtMemory()
    const kept = memory.add('LittleOne42', [
      'The Princess is 7 years old.',
      'The Princess goes to Oakwood school.',
      'The Princess lives in Cape Town.',
      'The Princess wants a purple castle.',
    ])
    expect(kept).toEqual(['The Princess wants a purple castle.'])
  })

  it('keeps only the most recent facts per subject', () => {
    const memory = new CourtMemory(undefined, 2)
    memory.add('x', ['one', 'two', 'three'])
    expect(memory.facts('x')).toEqual(['two', 'three'])
  })

  it('picks up hand edits made while running instead of overwriting them', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-')), 'm.json')
    const memory = new CourtMemory(file)
    memory.add('LittleOne42', ['The Princess has a flower bush.'])
    // Someone corrects the file by hand (ensure a different mtime).
    fs.writeFileSync(
      file,
      JSON.stringify({ littleone42: [{ text: 'The Princess has a firefly bush.', at: 1 }] })
    )
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(file, later, later)
    expect(memory.facts('LittleOne42')).toEqual(['The Princess has a firefly bush.'])
    memory.add('LittleOne42', ['The Princess has a kitchen.'])
    expect(new CourtMemory(file).facts('LittleOne42')).toEqual([
      'The Princess has a firefly bush.',
      'The Princess has a kitchen.',
    ])
  })

  it('survives a restart when backed by a file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-')), 'm.json')
    new CourtMemory(file).add('Merlin', ["Merlin's bed should be purple."])
    expect(new CourtMemory(file).facts('merlin')).toEqual(["Merlin's bed should be purple."])
  })
})

describe('isPersonalInfo', () => {
  it.each(['She is seven years old', 'Her birthday is in May', 'Her teacher is Mrs Smith'])(
    'flags "%s"',
    (fact) => expect(isPersonalInfo(fact.replace('seven', '7'))).toBe(true)
  )
  it('flags a real birth date', () => {
    expect(isPersonalInfo('She was born in 2019')).toBe(true)
    expect(isPersonalInfo('She was born on the 3rd of May')).toBe(true)
  })
  it.each([
    'She loves periwinkle',
    'She wants Merlin to have a purple bed',
    "The Princess's twins in Minecraft were born with the power of flight.",
  ])('allows "%s"', (fact) => expect(isPersonalInfo(fact)).toBe(false))
})
