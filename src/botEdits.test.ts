import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyBotEdits, botEdits, botProblems, readBotEdits } from './botEdits'

const FILE = [
  { name: 'Merlin', role: 'court wizard', magic: true, chat: { thinking: ['Hmm...'] } },
  { name: 'Henry', role: 'apprentice', reportsTo: 'Festaris', chat: { greeting: 'Hello' } },
  { name: 'Festaris', role: 'castellan' },
]

describe("the admin's edits to the bots", () => {
  it('keeps only what differs from the file, and gives the court back as edited', () => {
    const wanted = [
      { name: 'Merlin', role: 'court wizard', magic: true, chat: { thinking: ['Let me see...'] } },
      { name: 'Henry', role: 'builder', chat: { greeting: 'Hello' } },
      { name: 'Joan', role: 'cook', reportsTo: 'Festaris' },
    ]
    const edits = botEdits(FILE, wanted)
    expect(edits).toEqual({
      Merlin: { chat: { thinking: ['Let me see...'] } },
      Henry: { role: 'builder', reportsTo: null },
      Festaris: null,
      Joan: { name: 'Joan', role: 'cook', reportsTo: 'Festaris' },
    })
    expect(applyBotEdits(FILE, edits)).toEqual(wanted)
  })

  it('lets a deploy change what the admin did not touch', () => {
    const edits = botEdits(FILE, [FILE[0], { ...FILE[1], role: 'builder' }, FILE[2]])
    const deployed = FILE.map((b) => (b.name === 'Henry' ? { ...b, chat: { greeting: 'Hi!' } } : b))
    expect(applyBotEdits(deployed, edits)[1]).toEqual({
      name: 'Henry',
      role: 'builder',
      reportsTo: 'Festaris',
      chat: { greeting: 'Hi!' },
    })
  })

  it('reads no edits from a missing file, and refuses a broken one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edits-'))
    expect(readBotEdits(path.join(dir, 'none.json'))).toEqual({})
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ Merlin: 'wizard' }))
    expect(() => readBotEdits(path.join(dir, 'bad.json'))).toThrow(/Merlin/)
  })

  it('says what is wrong with a court', () => {
    expect(botProblems(FILE)).toEqual([])
    expect(
      botProblems([
        { name: 'Merlin' },
        { name: 'Merlin' },
        { name: 'Sir Bob' },
        { name: 'Wat', reportsTo: 'Nobody' },
      ])
    ).toEqual([
      'Duplicate bot name: Merlin',
      'Sir Bob: a player name has 1 to 16 letters, digits or underscores',
      'Wat reports to "Nobody", who is not another bot of the court',
    ])
  })
})
