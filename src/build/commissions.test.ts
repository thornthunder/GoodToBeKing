import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE } from './blueprints'
import { CommissionBook, MAX_COMMISSION_ATTEMPTS, describeCommission } from './Commissions'

const garden = {
  blueprint: 'garden' as const,
  title: 'a flower garden',
  palette: DEFAULT_PALETTE,
  requestedBy: 'LittleOne42',
  takenBy: 'Festaris',
  own: false,
}
const label = (p: string) => (p === 'LittleOne42' ? 'the Princess' : p)

describe('the commission book', () => {
  it('keeps a request across a restart, and starts a build cut short again', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commissions-')), 'c.json')
    const book = new CommissionBook(file)
    const c = book.add({ ...garden, near: { x: 10, y: 70, z: 20 } })
    book.start(c.id, 'George')
    const again = new CommissionBook(file)
    expect(again.waiting().map((w) => w.id)).toEqual([c.id])
  })

  it('waits for a free builder after a royal calls the builder away', () => {
    const book = new CommissionBook()
    const c = book.add(garden)
    book.start(c.id, 'George')
    book.finish(c.id, { ok: false, reason: 'cancelled' })
    expect(book.find(c.id)).toMatchObject({ status: 'waiting', worker: undefined, attempts: 0 })
  })

  it('tries an incomplete build again, and gives up where there is no ground', () => {
    const book = new CommissionBook()
    const c = book.add(garden)
    for (let i = 1; i < MAX_COMMISSION_ATTEMPTS; i++) {
      book.finish(c.id, { ok: false, reason: 'stuck' })
      expect(book.find(c.id)?.status).toBe('waiting')
    }
    book.finish(c.id, { ok: false, reason: 'stuck' })
    expect(book.find(c.id)?.status).toBe('failed')
    const d = book.add(garden)
    book.finish(d.id, { ok: false, reason: 'no_site' })
    expect(describeCommission(book.find(d.id)!, 'Festaris', label)).toBe(
      'a flower garden for the Princess: could not be built (there is no clear, flat ground there)'
    )
  })

  it('shows each courtier the builds it took or works on', () => {
    const book = new CommissionBook()
    const c = book.add(garden)
    expect(book.of('Festaris')).toHaveLength(1)
    expect(book.of('George')).toHaveLength(0)
    expect(describeCommission(c, 'Festaris', label)).toContain(
      'it waits until the Princess is in sight, to know where it goes'
    )
    book.start(c.id, 'George')
    expect(book.of('George')).toHaveLength(1)
    expect(describeCommission(book.find(c.id)!, 'George', label)).toBe(
      'a flower garden for the Princess: you are building it right now'
    )
  })
})
