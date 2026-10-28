import { describe, expect, it } from 'vitest'
import type { OllamaConfig } from '../config'
import { keepAliveSeconds, OllamaClient } from './OllamaClient'

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
} as never

const cfg: OllamaConfig = {
  host: 'http://ollama.test',
  model: 'small',
  temperature: 0.7,
  timeoutMs: 1000,
  keepAlive: '24h',
  numCtx: 8192,
  think: false,
}

/** A client whose server holds the given models and answers with each request's model name. */
function client(loaded: Array<{ name: string; context_length: number; expires_at: string }>) {
  const asked: Array<{ model: string; keep_alive?: string; options?: { num_ctx?: number } }> = []
  const c = new OllamaClient(cfg, silent)
  ;(c as unknown as { ollama: unknown }).ollama = {
    ps: async () => ({ models: loaded.map((m) => ({ ...m, model: m.name })) }),
    chat: async (request: (typeof asked)[number]) => {
      asked.push(request)
      if (request.model === 'down:31b') throw new Error('timed out')
      return { message: { role: 'assistant', content: request.model } }
    },
  }
  return { c, asked }
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

describe('a model shared with other programs on the server', () => {
  it('is used with the context it is loaded with and keeps its longer stay', async () => {
    const { c, asked } = client([
      { name: 'big:31b', context_length: 262_144, expires_at: inHours(10 * 365 * 24) },
    ])
    const reply = await c.chat([], { model: 'big:31b', shared: true })
    expect(reply.message.content).toBe('big:31b')
    expect(asked[0].options?.num_ctx).toBe(262_144)
    expect(asked[0].keep_alive).toBe('-1m')
  })

  it('stays at least as long as the court keeps its own models', async () => {
    const { c, asked } = client([{ name: 'big:31b', context_length: 4096, expires_at: inHours(1) }])
    await c.chat([], { model: 'big:31b', shared: true })
    expect(asked[0].keep_alive).toBe('86400s')
  })

  it('is loaded with the server defaults when it is not loaded, not with our context', async () => {
    const { c, asked } = client([])
    const reply = await c.chat([], { model: 'big:31b', shared: true })
    expect(reply.message.content).toBe('big:31b')
    expect(asked[0].options?.num_ctx).toBeUndefined()
    expect(asked[0].keep_alive).toBe('86400s')
  })

  it('leaves the answer to the configured model when it does not answer', async () => {
    const { c, asked } = client([])
    const reply = await c.chat([], { model: 'down:31b', shared: true })
    expect(reply.message.content).toBe('small')
    expect(asked.map((r) => r.model)).toEqual(['down:31b', 'small'])
    expect(asked[1]).toMatchObject({ keep_alive: '24h', options: { num_ctx: 8192 } })
  })

  it('a model not asked for as shared gets the configured settings, as before', async () => {
    const { c, asked } = client([])
    await c.chat([], { model: 'big:31b' })
    expect(asked[0]).toMatchObject({
      model: 'big:31b',
      keep_alive: '24h',
      options: { num_ctx: 8192 },
    })
  })
})

describe('keep-alive durations', () => {
  it('reads them the way Ollama does', () => {
    expect(keepAliveSeconds('24h')).toBe(86_400)
    expect(keepAliveSeconds('1h30m')).toBe(5400)
    expect(keepAliveSeconds('90s')).toBe(90)
    expect(keepAliveSeconds('300')).toBe(300)
    expect(keepAliveSeconds('-1m')).toBe(Infinity)
    expect(keepAliveSeconds(undefined)).toBe(300)
  })
})
