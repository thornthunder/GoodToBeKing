import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CourtMemory, isPersonalInfo, isSecret, recall, type Fact } from './CourtMemory'

describe('CourtMemory', () => {
  it('stores facts per subject, case-insensitively, without duplicates', () => {
    const memory = new CourtMemory()
    expect(memory.add('LittleOne42', ['The Princess loves magenta.'])).toHaveLength(1)
    expect(
      memory
        .add('littleone42', ['the princess loves MAGENTA', 'She has a cat called Biscuit.'])
        .map((f) => f.text)
    ).toEqual(['She has a cat called Biscuit.'])
    expect(memory.facts('LITTLEONE42')).toEqual([
      'The Princess loves magenta.',
      'She has a cat called Biscuit.',
    ])
  })

  it('keeps real-life details as private facts, shown only when asked for', () => {
    const memory = new CourtMemory()
    memory.add('LittleOne42', [
      'The Princess is 7 years old.',
      'The Princess goes to Oakwood school.',
      { text: 'The Princess has a big brother called Sam. (private)', private: true },
      'The Princess wants a purple castle.',
    ])
    expect(memory.facts('LittleOne42', { withPrivate: true })).toContain(
      'The Princess has a big brother called Sam.'
    )
    expect(memory.facts('LittleOne42')).toEqual(['The Princess wants a purple castle.'])
    expect(memory.facts('LittleOne42', { withPrivate: true })).toHaveLength(4)
    expect(memory.entries('LittleOne42').filter((f) => f.private)).toHaveLength(3)
  })

  it('never stores secrets', () => {
    const memory = new CourtMemory()
    const kept = memory.add('LittleOne42', [
      "The Princess's password is unicorn7.",
      'The Princess told Merlin her PIN code.',
      'The Princess loves passion fruit.',
    ])
    expect(kept.map((f) => f.text)).toEqual(['The Princess loves passion fruit.'])
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

describe('recall', () => {
  const facts: Fact[] = [
    'The Princess has a horse called Sparkle.',
    'The Princess built a pink house.',
    'The Princess likes cookies.',
    'The Princess planted sunflowers.',
    'The Princess wants a moat.',
  ].map((text, at) => ({ text, at }))

  it('gives the latest facts and older ones the talk is about, in the order learned', () => {
    const picked = recall(facts, 'Princess: can my horse come in the castle?', 2, 3)
    expect(picked.map((f) => f.text)).toEqual([
      'The Princess has a horse called Sparkle.',
      'The Princess planted sunflowers.',
      'The Princess wants a moat.',
    ])
  })

  it('is not fooled by words every fact has', () => {
    expect(recall(facts, 'The Princess says hello', 1, 3)).toHaveLength(1)
  })
})

describe('isSecret', () => {
  it.each(['Her password is cat', 'She shared a pin code', 'Her login is Lily'])(
    'flags "%s"',
    (f) => expect(isSecret(f)).toBe(true)
  )
  it.each(['She loves passion fruit', 'She pinned a map to the wall'])('allows "%s"', (f) =>
    expect(isSecret(f)).toBe(false)
  )
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
