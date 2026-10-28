import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CourtRules, OrderBook, confirmation, judge, rankOf } from './orders'

const KING = rankOf('king')
const PRINCESS = rankOf('princess')

describe('judging an order that clashes', () => {
  it('takes an order that clashes with nothing', () => {
    expect(judge(PRINCESS, KING, [])).toEqual({ kind: 'accept', replaces: [] })
  })

  it('declines anything against the laws of the court, even from the King', () => {
    expect(judge(KING, KING, [{ id: 'L2', rank: Infinity, law: true }])).toEqual({
      kind: 'decline',
      clashes: ['L2'],
    })
  })

  it('asks the King to confirm before setting another order aside', () => {
    expect(judge(KING, KING, [{ id: 'O1', rank: PRINCESS }])).toEqual({
      kind: 'confirm',
      clashes: ['O1'],
    })
    expect(judge(KING, KING, [{ id: 'O2', rank: KING }]).kind).toBe('confirm')
  })

  it("turns the Princess down when her order clashes with the King's", () => {
    expect(judge(PRINCESS, KING, [{ id: 'O1', rank: KING }])).toEqual({
      kind: 'decline',
      clashes: ['O1'],
    })
  })

  it("lets the Princess's newest order replace her own or a courtier's", () => {
    expect(
      judge(PRINCESS, KING, [
        { id: 'O1', rank: PRINCESS },
        { id: 'O2', rank: 0 },
      ])
    ).toEqual({ kind: 'accept', replaces: ['O1', 'O2'] })
  })
})

describe('the order book', () => {
  it('keeps standing orders and reports across a restart', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orders-')), 'o.json')
    const book = new OrderBook(file)
    book.add({ from: 'BigDad', by: 'the King', text: 'Be kind to the guests.' })
    const post = book.add({
      from: 'BigDad',
      by: 'the King',
      text: 'Stay by the gate.',
      post: { type: 'stay' },
    })
    book.addReport('the King gave me an order: Stay by the gate.')

    const again = new OrderBook(file)
    expect(again.orders.map((o) => o.id)).toEqual(['O1', 'O2'])
    expect(again.post()?.id).toBe(post.id)
    expect(again.reports).toHaveLength(1)
    again.reported()
    again.remove(['O2'])
    expect(new OrderBook(file).post()).toBeUndefined()
    expect(new OrderBook(file).reports).toEqual([])
    // Numbering goes on after a restart: an old id never comes back for a new order.
    expect(new OrderBook(file).add({ from: 'x', by: 'x', text: 'x' }).id).toBe('O3')
  })

  it('shares rules through one file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rules-')), 'r.json')
    new CourtRules(file).add({ from: 'BigDad', by: 'the King', text: 'Nobody digs in the garden.' })
    expect(new CourtRules(file).rules.map((r) => `${r.id} ${r.text}`)).toEqual([
      'R1 Nobody digs in the garden.',
    ])
  })
})

describe("the King's answer", () => {
  it.each(['yes', 'Yes, do it', 'Bruce, yes', 'go ahead', 'no problem', 'I am sure'])(
    '"%s" is a yes',
    (line) => expect(confirmation(line)).toBe('yes')
  )
  it.each(['no', 'No, leave it', 'Bruce no', 'never mind'])('"%s" is a no', (line) =>
    expect(confirmation(line)).toBe('no')
  )
  it.each(['what was that?', 'tell me a story'])('"%s" is neither', (line) =>
    expect(confirmation(line)).toBeUndefined()
  )
})
