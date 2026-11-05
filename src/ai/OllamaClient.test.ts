import { describe, expect, it } from 'vitest'
import type { OllamaConfig } from '../config'
import {
  isCloudModel,
  jsonContent,
  keepAliveSeconds,
  ModelQueue,
  OllamaClient,
  withFormatNote,
} from './OllamaClient'

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

describe('a cloud model, which ignores the format asked for', () => {
  const schema = { type: 'object', properties: { facts: { type: 'array' } } }

  /** A client whose server answers each request with the given content. */
  function answering(content: string) {
    const asked: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = []
    const c = new OllamaClient(cfg, silent)
    let listed = 0
    ;(c as unknown as { ollama: unknown }).ollama = {
      ps: async () => {
        listed++
        return { models: [] }
      },
      chat: async (request: (typeof asked)[number]) => {
        asked.push(request)
        return { message: { role: 'assistant', content } }
      },
    }
    return { c, asked, listed: () => listed }
  }

  it('is known by its name', () => {
    expect(isCloudModel('gemma4:31b-cloud')).toBe(true)
    expect(isCloudModel('beam:cloud')).toBe(true)
    expect(isCloudModel('gemma4:31b')).toBe(false)
    expect(isCloudModel('cloudy:7b')).toBe(false)
  })

  it('is told the schema in the system prompt, and its fence is taken off the answer', async () => {
    const { c, asked, listed } = answering('```json\n{"facts": ["a moat"]}\n```')
    const reply = await c.chat(
      [
        { role: 'system', content: 'You remember things.' },
        { role: 'user', content: 'The talk.' },
      ],
      { model: 'gemma4:31b-cloud', shared: true, format: schema }
    )
    expect(JSON.parse(reply.message.content)).toEqual({ facts: ['a moat'] })
    expect(asked[0].messages[0].content).toContain('You remember things.')
    expect(asked[0].messages[0].content).toContain(JSON.stringify(schema))
    expect(asked[0].messages[1].content).toBe('The talk.')
    expect(listed()).toBe(0)
  })

  it('a local model is asked as before', async () => {
    const { c, asked } = answering('{"facts": []}')
    const messages = [{ role: 'system', content: 'You remember things.' }]
    await c.chat(messages, { model: 'big:31b', shared: true, format: schema })
    expect(asked[0].messages).toEqual(messages)
  })

  it('answers are cut down to their JSON, and left alone when there is none', () => {
    expect(jsonContent('{"a": 1}')).toBe('{"a": 1}')
    expect(jsonContent('```\n{"a": 1}\n```')).toBe('{"a": 1}')
    expect(jsonContent('Here it is: {"a": {"b": 2}} as asked.')).toBe('{"a": {"b": 2}}')
    expect(jsonContent('No JSON here.')).toBe('No JSON here.')
  })

  it('a prompt without a system message gets one', () => {
    const messages = withFormatNote([{ role: 'user', content: 'Hi' }], 'json')
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[0].content).toContain('valid JSON')
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

describe('the queue for a shared model', () => {
  /** A task that takes `ms` and can be cut short. */
  const task = (log: string[], name: string, ms: number) => (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      log.push(`start ${name}`)
      const timer = setTimeout(() => resolve(name), ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        log.push(`cut ${name}`)
        reject(new Error('aborted'))
      })
    })

  it('serves urgent requests first and cuts a background one short, then runs it again', async () => {
    const queue = new ModelQueue()
    const log: string[] = []
    const memory = queue.run('background', task(log, 'memory', 50))
    await new Promise((r) => setTimeout(r, 5))
    const overlord = queue.run('normal', task(log, 'overlord', 10))
    const reading = queue.run('urgent', task(log, 'reading', 10))
    expect(await Promise.all([memory, overlord, reading])).toEqual([
      'memory',
      'overlord',
      'reading',
    ])
    expect(log).toEqual([
      'start memory',
      'cut memory',
      'start reading',
      'start overlord',
      'start memory',
    ])
  })

  it('never cuts a normal request short', async () => {
    const queue = new ModelQueue()
    const log: string[] = []
    const overlord = queue.run('normal', task(log, 'overlord', 30))
    await new Promise((r) => setTimeout(r, 5))
    const reading = queue.run('urgent', task(log, 'reading', 5))
    await Promise.all([overlord, reading])
    expect(log).toEqual(['start overlord', 'start reading'])
  })
})
