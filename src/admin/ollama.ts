import { OllamaClient } from '../ai/OllamaClient'
import { createLogger } from '../logger'
import { errMsg } from '../util'

/**
 * The Ollama servers the court may use, as the admin shows them: what each has, what it holds
 * loaded, and a test chat. Never a model loaded, pulled or unloaded for its own sake: the court
 * shares its server (and gemma4:31b) with another program, and a model asked for with another
 * context is loaded again (see CLAUDE.md). The test chat asks as the court does for a shared
 * model: with the context it is loaded with, never cutting its stay short.
 */
export interface OllamaService {
  name: string
  url: string
}

export interface ModelInfo {
  name: string
  sizeGb: number
  parameters?: string
  quantization?: string
  family?: string
  modifiedAt?: string
}

export interface LoadedModel {
  name: string
  sizeGb: number
  vramGb: number
  context?: number
  expiresAt?: string
}

export interface ServiceInfo {
  url: string
  ok: boolean
  error?: string
  version?: string
  models: ModelInfo[]
  loaded: LoadedModel[]
  /** How long the server took to answer. */
  ms?: number
}

const GB = 1024 ** 3

async function getJson(url: string, timeoutMs = 5_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.json()
}

export function checkUrl(url: string): string {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('an http(s) URL')
  return u.origin
}

export async function serviceInfo(url: string): Promise<ServiceInfo> {
  const base = checkUrl(url)
  const started = Date.now()
  try {
    const [version, tags, ps] = (await Promise.all([
      getJson(`${base}/api/version`),
      getJson(`${base}/api/tags`),
      getJson(`${base}/api/ps`),
    ])) as [
      { version?: string },
      { models?: Array<Record<string, unknown>> },
      { models?: Array<Record<string, unknown>> },
    ]
    const details = (m: Record<string, unknown>) => (m.details ?? {}) as Record<string, string>
    return {
      url: base,
      ok: true,
      version: version.version,
      ms: Date.now() - started,
      models: (tags.models ?? [])
        .map((m) => ({
          name: String(m.name),
          sizeGb: Math.round((Number(m.size) / GB) * 10) / 10,
          parameters: details(m).parameter_size,
          quantization: details(m).quantization_level,
          family: details(m).family,
          modifiedAt: m.modified_at as string | undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      loaded: (ps.models ?? []).map((m) => ({
        name: String(m.name),
        sizeGb: Math.round((Number(m.size) / GB) * 10) / 10,
        vramGb: Math.round((Number(m.size_vram) / GB) * 10) / 10,
        context: m.context_length as number | undefined,
        expiresAt: m.expires_at as string | undefined,
      })),
    }
  } catch (err) {
    return { url: base, ok: false, error: errMsg(err), models: [], loaded: [] }
  }
}

/** One question to a model, asked as the court asks a shared model. */
export async function testChat(
  url: string,
  model: string,
  prompt: string
): Promise<{ answer: string; ms: number; promptTokens?: number; outputTokens?: number }> {
  if (!/^[\w.:/-]{1,100}$/.test(model)) throw new Error('not a model name')
  if (!prompt.trim() || prompt.length > 2_000)
    throw new Error('a question of at most 2000 characters')
  const client = new OllamaClient(
    { host: checkUrl(url), model, temperature: 0.7, timeoutMs: 10 * 60_000, keepAlive: '24h' },
    createLogger('admin:ollama')
  )
  const started = Date.now()
  const res = await client.chat([{ role: 'user', content: prompt }], {
    shared: true,
    stream: true,
    priority: 'normal',
  })
  return {
    answer: res.message.content,
    ms: Date.now() - started,
    promptTokens: res.prompt_eval_count,
    outputTokens: res.eval_count,
  }
}
