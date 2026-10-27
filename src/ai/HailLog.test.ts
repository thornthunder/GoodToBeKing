import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HailLog } from './HailLog'

describe('HailLog', () => {
  it('tracks recent hails case-insensitively', () => {
    const log = new HailLog()
    log.set('LittleOne42', 1_000)
    expect(log.recent('littleone42', 500, 1_400)).toBe(true)
    expect(log.recent('littleone42', 500, 1_600)).toBe(false)
    expect(log.recent('Stranger', 500, 1_400)).toBe(false)
  })

  it('survives a restart when backed by a file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hails-')), 'sub', 'm.json')
    new HailLog(file).set('BigDad', 42)
    expect(new HailLog(file).get('bigdad')).toBe(42)
  })

  it('ignores a corrupt file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hails-')), 'bad.json')
    fs.writeFileSync(file, '{not json')
    expect(new HailLog(file).get('x')).toBeUndefined()
  })
})
