import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS, invalid } from './settings'

/** Every setting the court's own code reads from the environment. */
function courtSettings(): string[] {
  const keys = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'admin') walk(file)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const text = fs.readFileSync(file, 'utf8')
        for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) keys.add(m[1])
        for (const m of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) keys.add(m[1])
        for (const m of text.matchAll(/\benv[A-Za-z]*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g))
          keys.add(m[1])
      }
    }
  }
  walk(path.resolve(__dirname, '..'))
  return [...keys].sort()
}

describe("the admin's settings", () => {
  it('knows every setting the court reads', () => {
    const known = new Set(SETTINGS.map((s) => s.key))
    const read = courtSettings()
    expect(read.length).toBeGreaterThan(40)
    expect(read.filter((k) => !known.has(k))).toEqual([])
  })

  it('refuses values the court would not read', () => {
    expect(invalid('MC_PORT', '19132')).toBeUndefined()
    expect(invalid('MC_PORT', 'abc')).toBe('must be a number')
    expect(invalid('MC_TRANSPORT', 'nethernet')).toBeUndefined()
    expect(invalid('MC_TRANSPORT', 'carrier pigeon')).toMatch(/one of raknet, nethernet/)
    expect(invalid('BUILD_CENTER', '105, 75, 122')).toBeUndefined()
    expect(invalid('BUILD_CENTER', '105 75')).toBe('"x,y,z"')
    expect(invalid('OLLAMA_HOST', 'http://10.0.0.7:11434')).toBeUndefined()
    expect(invalid('OLLAMA_HOST', 'ava')).toMatch(/URL/)
    expect(invalid('COMMAND_FILE', 'x')).toMatch(/container/)
    expect(invalid('BOT_GREETING', 'two\nlines')).toBe('one line only')
    expect(invalid('MC_PORT', '')).toBeUndefined()
  })
})
