import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import type { Plan, Section } from './compile'
import type { Job, JobResult } from './Mason'

/** A bot that can take on work orders. */
export interface Worker {
  readonly name: string
  /** Free to take a work order now (spawned, idle, not on duty). */
  available(): boolean
  position(): { x: number; y: number; z: number } | undefined
  work(job: Job): Promise<JobResult>
  /** Nothing to do right now: go and wait at this spot (out of the way of the work). */
  idle?(spot: { x: number; y: number; z: number }): void
}

export type WorksEvent =
  | { kind: 'begin'; plan: Plan }
  | { kind: 'assign'; section: Section; worker: string }
  | { kind: 'done'; section: Section; worker: string; result: JobResult; complete: boolean }
  | { kind: 'finished'; plan: Plan }

type Status = 'todo' | 'doing' | 'done'

interface SectionState {
  status: Status
  by?: string
  attempts: number
  missing?: number
  /** Given one more try after a restart (new code may place what the old could not). */
  touchedUp?: boolean
}

interface WorksFile {
  plan: string
  startedAt?: number
  finishedAt?: number
  sections: Record<string, SectionState>
}

/** A section is retried this often before the crew moves on and leaves its gaps. */
export const MAX_ATTEMPTS = 3

/**
 * The court's building works: hands each free worker the next section whose prerequisites are
 * finished, preferring one close by, retries sections that came out incomplete, and keeps its
 * progress in a file so a restart carries on where it stopped.
 */
export class Works {
  private state: WorksFile
  /** Worker name -> section id. */
  private readonly running = new Map<string, string>()
  private readonly centres = new Map<string, { x: number; z: number }>()
  /** 'finished' was reported (or the works were already finished when loaded). */
  private announced = false
  /** Free courtyard cells where idle workers wait. */
  private readonly restSpots: Array<{ x: number; y: number; z: number }> = []
  private readonly restIndex = new Map<string, number>()
  paused = false

  constructor(
    readonly plan: Plan,
    private readonly file: string | undefined,
    private readonly log: Logger,
    private readonly onEvent?: (e: WorksEvent) => void
  ) {
    this.state = this.load()
    for (const s of plan.sections) {
      const st = (this.state.sections[s.id] ??= { status: 'todo', attempts: 0 })
      if (st.status === 'doing') st.status = 'todo' // interrupted by a restart
      if (st.status === 'done' && (st.missing ?? 0) > 0 && !st.touchedUp) {
        st.status = 'todo'
        st.attempts = MAX_ATTEMPTS - 1
        st.touchedUp = true
      }
      const xs = [...s.cells.map((c) => c.x), ...s.columns.map((c) => c.x)]
      const zs = [...s.cells.map((c) => c.z), ...s.columns.map((c) => c.z)]
      this.centres.set(s.id, {
        x: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
        z: zs.reduce((a, b) => a + b, 0) / Math.max(1, zs.length),
      })
    }
    this.announced = this.finished
    this.save()
    // Resting spots: courtyard paving with nothing planned on it (and not at the very edge).
    const yard = plan.sections.filter((s) => s.kind === 'courtyard').flatMap((s) => s.cells)
    for (const c of yard) {
      const free = [1, 2].every((dy) => !plan.planned.has(`${c.x},${c.y + dy},${c.z}`))
      const near = [-1, 1].some(
        (d) =>
          plan.planned.has(`${c.x + d},${c.y + 1},${c.z}`) ||
          plan.planned.has(`${c.x},${c.y + 1},${c.z + d}`)
      )
      if (free && !near && c.y === plan.floorY) this.restSpots.push({ x: c.x, y: c.y + 1, z: c.z })
    }
  }

  private restSpotFor(worker: string): { x: number; y: number; z: number } | undefined {
    if (!this.restSpots.length) return undefined
    if (!this.restIndex.has(worker)) this.restIndex.set(worker, this.restIndex.size)
    const i = this.restIndex.get(worker)!
    // Spread the crew over the courtyard.
    return this.restSpots[Math.floor((i * this.restSpots.length) / 7) % this.restSpots.length]
  }

  get finished(): boolean {
    return this.plan.sections.every((s) => this.state.sections[s.id]?.status === 'done')
  }

  get started(): boolean {
    return this.state.startedAt !== undefined
  }

  progress(): { done: number; total: number; doing: Array<{ worker: string; title: string }> } {
    const done = this.plan.sections.filter(
      (s) => this.state.sections[s.id]?.status === 'done'
    ).length
    const doing = [...this.running].map(([worker, id]) => ({
      worker,
      title: this.plan.sections.find((s) => s.id === id)?.title ?? id,
    }))
    return { done, total: this.plan.sections.length, doing }
  }

  /** For the bots' prompts: "the Great Castle (7 of 21 parts done; Henry is building ...)". */
  summary(): string {
    const { done, total, doing } = this.progress()
    if (done === total) return `${this.plan.title}, which is now finished`
    const who = doing.map((d) => `${d.worker} is building ${d.title}`).join('; ')
    return `${this.plan.title} (${done} of ${total} parts done${who ? `; ${who}` : ''})`
  }

  /** Assign work to every free worker. Call regularly. */
  tick(workers: Worker[]): void {
    if (this.paused || this.finished) return
    for (const w of workers) {
      if (this.running.has(w.name)) continue
      if (!isFree(w)) continue
      const next = this.next(w)
      if (!next) {
        const spot = this.restSpotFor(w.name)
        if (spot) w.idle?.(spot)
        continue
      }
      this.start(w, next)
    }
  }

  private next(w: Worker): Section | undefined {
    const ready = this.plan.sections.filter(
      (s) =>
        this.state.sections[s.id]?.status === 'todo' &&
        s.after.every((id) => this.state.sections[id]?.status === 'done')
    )
    if (!ready.length) return undefined
    // Sections meant for this worker first, then unassigned ones, then other crews' (rather than idle).
    const fit = (s: Section) =>
      !s.crew?.length ? 1 : s.crew.some((n) => n.toLowerCase() === w.name.toLowerCase()) ? 0 : 2
    const best = Math.min(...ready.map(fit))
    // Among the first few in plan order, the closest to the worker.
    const pos = w.position()
    const options = ready.filter((s) => fit(s) === best).slice(0, 4)
    if (!pos) return options[0]
    const d = (s: Section) => {
      const c = this.centres.get(s.id)!
      return Math.hypot(c.x - pos.x, c.z - pos.z)
    }
    return options.sort((a, b) => d(a) - d(b))[0]
  }

  private start(w: Worker, s: Section): void {
    const st = this.state.sections[s.id]
    st.status = 'doing'
    st.by = w.name
    this.running.set(w.name, s.id)
    if (this.state.startedAt === undefined) {
      this.state.startedAt = Date.now()
      this.emit({ kind: 'begin', plan: this.plan })
    }
    this.save()
    this.log.info(
      `${w.name} takes ${s.title} (${s.cells.length} blocks, ${s.columns.length} columns)`
    )
    this.emit({ kind: 'assign', section: s, worker: w.name })
    const job: Job = {
      id: s.id,
      title: s.title,
      cells: s.cells,
      columns: s.columns,
      planned: this.plan.planned,
    }
    w.work(job)
      .then((result) => this.finish(w.name, s, result))
      .catch((err) => {
        this.log.warn(`${w.name} failed at ${s.title}: ${errMsg(err)}`)
        this.finish(w.name, s, {
          placed: 0,
          dug: 0,
          missing: s.cells.length,
          blocked: 0,
          cancelled: true,
        })
      })
  }

  private finish(worker: string, s: Section, result: JobResult): void {
    this.running.delete(worker)
    const st = this.state.sections[s.id]
    st.missing = result.missing
    const allowed = Math.max(2, Math.floor(s.cells.length * 0.02))
    const complete = result.missing <= allowed
    if (result.cancelled && !complete) {
      st.status = 'todo'
      st.by = undefined
    } else if (complete) {
      st.status = 'done'
    } else {
      st.attempts++
      st.status = st.attempts >= MAX_ATTEMPTS ? 'done' : 'todo'
      if (st.status === 'done')
        this.log.warn(
          `${s.title}: leaving ${result.missing} blocks missing after ${st.attempts} tries`
        )
    }
    this.save()
    if (!result.cancelled) this.emit({ kind: 'done', section: s, worker, result, complete })
    if (this.finished && !this.announced) {
      this.announced = true
      this.state.finishedAt ??= Date.now()
      this.save()
      this.log.info(`${this.plan.title} is finished`)
      this.emit({ kind: 'finished', plan: this.plan })
    }
  }

  private emit(e: WorksEvent): void {
    try {
      this.onEvent?.(e)
    } catch (err) {
      this.log.warn(`works event handler failed: ${errMsg(err)}`)
    }
  }

  private load(): WorksFile {
    if (this.file && fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as WorksFile
        if (parsed.plan === this.plan.id && parsed.sections) return parsed
      } catch {
        // start afresh
      }
    }
    return { plan: this.plan.id, sections: {} }
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }
}

function isFree(w: Worker): boolean {
  try {
    return w.available()
  } catch {
    return false
  }
}
