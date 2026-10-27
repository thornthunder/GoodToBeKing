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

/** Thin wrapper around the Ollama HTTP client with timeouts, defaults and logging. */
export class OllamaClient implements ChatModel {
  private readonly ollama: Ollama
  /** Per model: the `think` value to send by default (see resolveThink). */
  private readonly thinkDefaults = new Map<string, Promise<boolean | undefined>>()

  constructor(
    readonly cfg: OllamaConfig,
    private readonly log: Logger
  ) {
    const timeoutMs = cfg.timeoutMs
    this.ollama = new Ollama({
      host: cfg.host,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    })
  }

  get model(): string {
    return this.cfg.model
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const model = opts.model ?? this.cfg.model
    const request: ChatRequest & { stream: false } = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? this.cfg.temperature,
        ...(this.cfg.numCtx !== undefined ? { num_ctx: this.cfg.numCtx } : {}),
      },
    }
    if (this.cfg.keepAlive) request.keep_alive = this.cfg.keepAlive
    if (opts.tools?.length) request.tools = opts.tools
    if (opts.format !== undefined) request.format = opts.format
    const think = opts.think ?? (await this.resolveThink(model))
    if (think !== undefined) request.think = think

    const started = Date.now()
    const response = await this.ollama.chat(request)
    const ms = Date.now() - started
    this.log.debug(
      `chat(${model}) ${ms}ms, prompt=${response.prompt_eval_count ?? '?'} tokens, ` +
        `output=${response.eval_count ?? '?'} tokens, done=${response.done_reason}`
    )
    return response
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
