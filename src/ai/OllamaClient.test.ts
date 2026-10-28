import { describe, expect, it } from 'vitest'
import type { OllamaConfig } from '../config'
import { OllamaClient } from './OllamaClient'

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

const forever = new Date(Date.now() + 10 * 365 * 86_400_000).toISOString()

describe('borrowing a model another program keeps loaded', () => {
  it('uses it with the context and keep-alive it was loaded with', async () => {
    const { c, asked } = client([{ name: 'big:31b', context_length: 262_144, expires_at: forever }])
    const reply = await c.chat([], { model: 'big:31b', borrow: true })
    expect(reply.message.content).toBe('big:31b')
    expect(asked[0].options?.num_ctx).toBe(262_144)
    expect(asked[0].keep_alive).toBe('-1m')
  })

  it('leaves it alone when it is not loaded: the configured model answers', async () => {
    const { c, asked } = client([])
    const reply = await c.chat([], { model: 'big:31b', borrow: true })
    expect(reply.message.content).toBe('small')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ keep_alive: '24h', options: { num_ctx: 8192 } })
  })

  it('asks the configured model when the borrowed one does not answer', async () => {
    const { c, asked } = client([{ name: 'down:31b', context_length: 4096, expires_at: forever }])
    const reply = await c.chat([], { model: 'down:31b', borrow: true })
    expect(reply.message.content).toBe('small')
    expect(asked.map((r) => r.model)).toEqual(['down:31b', 'small'])
  })

  it('loads a model asked for without borrowing, as before', async () => {
    const { c, asked } = client([])
    await c.chat([], { model: 'big:31b' })
    expect(asked[0]).toMatchObject({ model: 'big:31b', keep_alive: '24h' })
  })
})
