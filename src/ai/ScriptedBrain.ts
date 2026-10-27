import type { Brain, BrainContext, BrainReply, BuildOutcome, ChatEvent } from './Brain'

export interface Script {
  onSpawn?: (ctx: BrainContext) => string | null
  onPlayerJoin?: (player: string, ctx: BrainContext) => string | null
  onChat?: (event: ChatEvent, ctx: BrainContext) => string | BrainReply | null
  onNotice?: (event: ChatEvent, ctx: BrainContext) => string | null
  onStuck?: (target: string, ctx: BrainContext) => string | null
  onBuildDone?: (outcome: BuildOutcome, ctx: BrainContext) => string | null
  speak?: (instruction: string, ctx: BrainContext) => string | null
}

/** Deterministic brain for tests and smoke runs: no model involved. */
export class ScriptedBrain implements Brain {
  constructor(private readonly script: Script) {}

  async onSpawn(ctx: BrainContext): Promise<string | null> {
    return this.script.onSpawn?.(ctx) ?? null
  }

  async onPlayerJoin(player: string, ctx: BrainContext): Promise<string | null> {
    return this.script.onPlayerJoin?.(player, ctx) ?? null
  }

  async onChat(event: ChatEvent, ctx: BrainContext): Promise<BrainReply | null> {
    const reply = this.script.onChat?.(event, ctx) ?? null
    return typeof reply === 'string' ? { say: reply } : reply
  }

  async onNotice(event: ChatEvent, ctx: BrainContext): Promise<string | null> {
    return this.script.onNotice?.(event, ctx) ?? null
  }

  async onStuck(target: string, ctx: BrainContext): Promise<string | null> {
    return this.script.onStuck?.(target, ctx) ?? null
  }

  async onBuildDone(outcome: BuildOutcome, ctx: BrainContext): Promise<string | null> {
    return this.script.onBuildDone?.(outcome, ctx) ?? null
  }

  async speak(instruction: string, ctx: BrainContext, fallback?: string): Promise<string | null> {
    return this.script.speak?.(instruction, ctx) ?? fallback ?? null
  }
}
