import { describe, expect, it } from 'vitest'
import { STUCK_AFTER_FAILURES, StuckDetector } from './movement'

describe('StuckDetector', () => {
  it('reports stuck once after several failures in a row, then unstuck once', () => {
    const d = new StuckDetector()
    const results = []
    for (let i = 0; i < STUCK_AFTER_FAILURES + 3; i++) results.push(d.update('noPath'))
    expect(results.filter((r) => r === 'stuck')).toHaveLength(1)
    expect(results[STUCK_AFTER_FAILURES - 1]).toBe('stuck')
    expect(d.update('success')).toBe('unstuck')
    expect(d.update('success')).toBeNull()
  })

  it('does not report when failures are interrupted by successes', () => {
    const d = new StuckDetector()
    for (let i = 0; i < STUCK_AFTER_FAILURES * 2; i++) {
      expect(d.update(i % 3 === 2 ? 'partial' : 'timeout')).toBeNull()
    }
  })

  it('starts over after a reset', () => {
    const d = new StuckDetector()
    for (let i = 0; i < STUCK_AFTER_FAILURES; i++) d.update('noPath')
    d.reset()
    expect(d.update('success')).toBeNull()
  })
})
