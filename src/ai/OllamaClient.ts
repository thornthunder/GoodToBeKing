import { AsyncLocalStorage } from 'node:async_hooks'
import { Ollama, type ChatRequest, type ChatResponse, type Message, type Tool } from 'ollama'
import type { OllamaConfig } from '../config'
import type { Logger } from '../logger'
import { errMsg } from '../util'

export type ChatMessage = Message

export interface ChatOptions {
  tools?: Tool[]
  think?: boolean
  /** 'json' or a JSON schema object for structured output. */
  format?: string | object
  /** Overrides the configured temperature for this request. */
  temperature?: number
  /** Overrides the configured model for this request. */
  model?: string
  /**
   * The model is shared with other programs on the server (gemma4:31b): use it with the context it
   * is loaded with, or the server's default context when it is not loaded (as the others load it),
   * and never cut its stay short. Asking for another context makes the server load it again. When
   * a shared `model` other than the configured one does not answer, the configured one does.
   */
  shared?: boolean
  /** Overrides the configured timeout for this request (a cold big model takes a while). */
  timeoutMs?: number
  /**
   * Stream the answer and join it up. Needed for answers that take minutes: without streaming,
   * Node's fetch gives up when no response headers arrive within five minutes.
   */
  stream?: boolean
}

export interface OllamaHealth {
  version: string
  models: string[]
  /** Whether the configured model is present on the server. */
  hasModel: boolean
}

/** The slice of the client a brain needs; lets tests swap in a fake model. */
export interface ChatModel {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>
}

/** Per request: a timeout overriding the configured one (ChatOptions.timeoutMs). */
const requestTimeout = new AsyncLocalStorage<number>()

/** Thin wrapper around the Ollama HTTP client with timeouts, defaults and logging. */
export class OllamaClient implements ChatModel {
  private readonly ollama: Ollama
  /** Per model: the `think` value to send by default (see resolveThink). */
  private readonly thinkDefaults = new Map<string, Promise<boolean | undefined>>()
  /** Per shared model: whether it was loaded when last asked (to log only the changes). */
  private readonly sharedLoaded = new Map<string, boolean>()

  constructor(
    readonly cfg: OllamaConfig,
    private readonly log: Logger
  ) {
    const timeoutMs = cfg.timeoutMs
    this.ollama = new Ollama({
      host: cfg.host,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(requestTimeout.getStore() ?? timeoutMs),
        }),
    })
  }

  get model(): string {
    return this.cfg.model
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const model = opts.model ?? this.cfg.model
    if (!opts.shared) return this.send(messages, opts, model, this.cfg)
    const load = await this.sharedLoad(model)
    if (model === this.cfg.model) return this.send(messages, opts, model, load)
    try {
      return await this.send(messages, opts, model, load)
    } catch (err) {
      this.log.info(`${model} did not answer (${errMsg(err)}): asking ${this.cfg.model}`)
      return this.send(messages, { ...opts, timeoutMs: undefined }, this.cfg.model, this.cfg)
    }
  }

  /**
   * How to ask for a shared model: with the context it is loaded with (none when it is not loaded,
   * so it comes with the server's default), and with the longer of our keep-alive and its own.
   */
  private async sharedLoad(model: string): Promise<{ numCtx?: number; keepAlive: string }> {
    const held = await this.loaded(model)
    if (this.sharedLoaded.get(model) !== !!held) {
      this.sharedLoaded.set(model, !!held)
      this.log.info(
        held
          ? `${model} is loaded (context ${held.contextLength ?? '?'}): using it as it is`
          : `${model} is not loaded: loading it with the server's defaults`
      )
    }
    const stay = Math.max(keepAliveSeconds(this.cfg.keepAlive), held?.secondsLeft ?? 0)
    return {
      numCtx: held?.contextLength,
      keepAlive: stay === Infinity ? '-1m' : `${Math.ceil(stay)}s`,
    }
  }

  private async send(
    messages: ChatMessage[],
    opts: ChatOptions,
    model: string,
    load: { numCtx?: number; keepAlive?: string }
  ): Promise<ChatResponse> {
    const request: ChatRequest & { stream: false } = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? this.cfg.temperature,
        ...(load.numCtx !== undefined ? { num_ctx: load.numCtx } : {}),
      },
    }
    if (load.keepAlive) request.keep_alive = load.keepAlive
    if (opts.tools?.length) request.tools = opts.tools
    if (opts.format !== undefined) request.format = opts.format
    const think = opts.think ?? (await this.resolveThink(model))
    if (think !== undefined) request.think = think

    const started = Date.now()
    const call = () => (opts.stream ? this.streamed(request) : this.ollama.chat(request))
    const response = opts.timeoutMs ? await requestTimeout.run(opts.timeoutMs, call) : await call()
    const ms = Date.now() - started
    this.log.debug(
      `chat(${model}) ${ms}ms, prompt=${response.prompt_eval_count ?? '?'} tokens, ` +
        `output=${response.eval_count ?? '?'} tokens, done=${response.done_reason}`
    )
    return response
  }

  /** How the server holds a model right now, if it is loaded: its context and its time left. */
  private async loaded(
    model: string
  ): Promise<{ contextLength?: number; secondsLeft: number } | undefined> {
    const name = model.includes(':') ? model : `${model}:latest`
    try {
      const { models } = await this.ollama.ps()
      const m = models.find((x) => x.name === name || x.model === name)
      if (!m) return undefined
      const left = (new Date(m.expires_at).getTime() - Date.now()) / 1000
      return {
        contextLength: (m as { context_length?: number }).context_length,
        secondsLeft: left > 365 * 86_400 ? Infinity : Math.max(0, left),
      }
    } catch (err) {
      this.log.debug(`could not list loaded models: ${errMsg(err)}`)
      return undefined
    }
  }

  private async streamed(request: ChatRequest): Promise<ChatResponse> {
    const parts = await this.ollama.chat({ ...request, stream: true })
    let content = ''
    let thinking = ''
    let last: ChatResponse | undefined
    for await (const part of parts) {
      content += part.message?.content ?? ''
      thinking += part.message?.thinking ?? ''
      last = part
    }
    if (!last) throw new Error('empty answer')
    return {
      ...last,
      message: { ...last.message, role: 'assistant', content, ...(thinking ? { thinking } : {}) },
    }
  }

  /**
   * Thinking makes chat replies many times slower (9s vs 0.3s on gemma4:12b), so unless the
   * config says otherwise we switch it off on models that support it and leave the flag out
   * entirely on models that do not (Ollama rejects `think` for those).
   */
  private resolveThink(model: string): Promise<boolean | undefined> {
    if (this.cfg.think !== undefined) return Promise.resolve(this.cfg.think)
    let resolved = this.thinkDefaults.get(model)
    if (!resolved) {
      resolved = this.ollama
        .show({ model })
        .then((info) => {
          const capabilities = (info as { capabilities?: string[] }).capabilities ?? []
          this.log.debug(`model ${model} capabilities: ${capabilities.join(', ') || 'unknown'}`)
          return capabilities.includes('thinking') ? false : undefined
        })
        .catch((err) => {
          this.log.warn(
            `could not read capabilities of ${model} (${errMsg(err)}); leaving thinking at model default`
          )
          return undefined
        })
      this.thinkDefaults.set(model, resolved)
    }
    return resolved
  }

  async health(): Promise<OllamaHealth> {
    const versionUrl = `${this.cfg.host.replace(/\/$/, '')}/api/version`
    const [versionRes, list] = await Promise.all([
      fetch(versionUrl, { signal: AbortSignal.timeout(5_000) }),
      this.ollama.list(),
    ])
    if (!versionRes.ok) throw new Error(`${versionUrl} responded ${versionRes.status}`)
    const { version } = (await versionRes.json()) as { version: string }
    const models = list.models.map((m) => m.name)
    const wanted = this.cfg.model
    const hasModel = models.some((m) => m === wanted || m === `${wanted}:latest`)
    return { version, models, hasModel }
  }
}

/** Seconds in an Ollama keep-alive ("24h", "90s", "1h30m", "300"); negative means forever. */
export function keepAliveSeconds(value: string | undefined): number {
  const v = value?.trim()
  if (!v) return 300 // Ollama's default
  if (v.startsWith('-')) return Infinity
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v)
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 }
  let total = 0
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(n) * unit[u]
  return total
}
