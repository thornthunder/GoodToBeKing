import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeLogFiles, createLogger, logToFiles } from './logger'

describe('logToFiles', () => {
  afterEach(async () => {
    await closeLogFiles()
    vi.restoreAllMocks()
  })

  it('writes one file a day and drops those older than a week', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-logs-'))
    const old = path.join(dir, 'court-2020-01-01.log')
    fs.writeFileSync(old, 'old\n')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept\n')
    logToFiles(dir)
    createLogger('app').info('the Princess joined')
    createLogger('app').debug('not at info level')
    await closeLogFiles()
    const today = path.join(dir, `court-${new Date().toISOString().slice(0, 10)}.log`)
    const text = fs.readFileSync(today, 'utf8')
    expect(text).toMatch(/INFO {2}\[app\] the Princess joined\n$/)
    expect(text).not.toContain('not at info level')
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
  })
})
