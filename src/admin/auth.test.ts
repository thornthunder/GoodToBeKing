import { describe, expect, it } from 'vitest'
import { Sessions, Throttle, hashPassword, newPassword, verifyPassword, weakPassword } from './auth'

describe("the admin's sign-in", () => {
  it('keeps only a hash of the password and knows it again', () => {
    const stored = hashPassword('the right one')
    expect(stored).not.toContain('the right one')
    expect(verifyPassword('the right one', stored)).toBe(true)
    expect(verifyPassword('the wrong one', stored)).toBe(false)
    expect(verifyPassword('anything', 'garbage')).toBe(false)
  })

  it('makes passwords that are long enough', () => {
    const p = newPassword()
    expect(p).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/)
    expect(weakPassword(p)).toBeUndefined()
    expect(weakPassword('short')).toBeDefined()
  })

  it('ends sessions that sat idle', () => {
    const sessions = new Sessions()
    const id = sessions.open('1.2.3.4', 0)
    expect(sessions.check(id, 60_000)).toBe(true)
    expect(sessions.check(id, 60_000 + 13 * 60 * 60_000)).toBe(false)
    expect(sessions.check('made-up')).toBe(false)
  })

  it('makes an address wait after five wrong passwords', () => {
    const throttle = new Throttle()
    for (let i = 0; i < 4; i++) throttle.failed('5.6.7.8', 0)
    expect(throttle.wait('5.6.7.8', 0)).toBe(0)
    throttle.failed('5.6.7.8', 0)
    expect(throttle.wait('5.6.7.8', 0)).toBe(60_000)
    throttle.failed('5.6.7.8', 0)
    expect(throttle.wait('5.6.7.8', 0)).toBe(120_000)
    throttle.succeeded('5.6.7.8')
    expect(throttle.wait('5.6.7.8', 0)).toBe(0)
  })
})
