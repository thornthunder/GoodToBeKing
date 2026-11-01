import { describe, expect, it } from 'vitest'
import { EnvFile, quote } from './envfile'

describe('a .env file edited by the admin', () => {
  const TEXT = [
    '# ---- Minecraft Bedrock server to join ----',
    'MC_HOST=127.0.0.1',
    'MC_PORT=19132 # the default',
    '',
    "BOT_GREETING='Merlin has arrived.'",
    'OLLAMA_THINK=',
  ].join('\n')

  it('reads keys, values, quotes and comments', () => {
    const env = new EnvFile(TEXT)
    expect(env.entries()).toEqual({
      MC_HOST: '127.0.0.1',
      MC_PORT: '19132',
      BOT_GREETING: 'Merlin has arrived.',
      OLLAMA_THINK: '',
    })
  })

  it('changes a value where it stands and keeps every other line', () => {
    const env = new EnvFile(TEXT)
    env.set('MC_HOST', '10.0.0.5')
    env.set('LOG_LEVEL', 'debug')
    env.set('OLLAMA_THINK', undefined)
    expect(env.toString()).toBe(
      [
        '# ---- Minecraft Bedrock server to join ----',
        'MC_HOST=10.0.0.5',
        'MC_PORT=19132 # the default',
        '',
        "BOT_GREETING='Merlin has arrived.'",
        'LOG_LEVEL=debug',
        '',
      ].join('\n')
    )
  })

  it('quotes what would otherwise read back differently', () => {
    expect(quote('gemma4:e4b')).toBe('gemma4:e4b')
    expect(quote('Speak my name and I shall attend.')).toBe('Speak my name and I shall attend.')
    expect(quote('a #hash')).toBe("'a #hash'")
    expect(quote("the King's court")).toBe('"the King\'s court"')
    expect(() => quote('two\nlines')).toThrow()
    for (const v of ['a #hash', 'the King\'s "court"', ' padded ', 'plain'])
      expect(new EnvFile(`X=${quote(v)}`).get('X')).toBe(v)
  })
})
