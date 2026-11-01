import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'

/**
 * Programs the admin runs (docker, git, the court's scripts): never through a shell, always with
 * their arguments as a list. Short ones are awaited; long ones (a rebuild, a survey) become jobs
 * whose output the page follows.
 */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr) || (err && code !== 0 ? err.message : ''),
        })
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export interface Job {
  id: string
  title: string
  /** Jobs of one key run one at a time (e.g. "rebuild:dev"). */
  key: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  code?: number
  output: string
  /** A file the job made that the page can show (a picture of a castle). */
  file?: string
}

/** Keep this much of a job's output (the end of it). */
const MAX_OUTPUT = 512 * 1024
const KEEP_JOBS = 40

export class Jobs {
  private readonly jobs = new Map<string, Job>()

  list(): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((j) => ({ ...j, output: j.output.slice(-2_000) }))
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  running(key: string): Job | undefined {
    return [...this.jobs.values()].find((j) => j.key === key && j.status === 'running')
  }

  /**
   * Run the steps one after another (each a program and its arguments), stopping at the first
   * that fails. Returns the job at once.
   */
  start(
    title: string,
    key: string,
    steps: Array<{ cmd: string; args: string[]; cwd?: string; timeoutMs?: number }>,
    opts: { file?: string; after?: (job: Job) => void } = {}
  ): Job {
    const busy = this.running(key)
    if (busy) throw new Error(`already under way: ${busy.title}`)
    const job: Job = {
      id: crypto.randomBytes(6).toString('hex'),
      title,
      key,
      status: 'running',
      startedAt: Date.now(),
      output: '',
      ...(opts.file ? { file: opts.file } : {}),
    }
    this.jobs.set(job.id, job)
    this.trim()
    const write = (text: string) => {
      job.output = (job.output + text).slice(-MAX_OUTPUT)
    }
    void (async () => {
      for (const step of steps) {
        write(`$ ${step.cmd} ${step.args.join(' ')}\n`)
        const code = await new Promise<number>((resolve) => {
          const child = spawn(step.cmd, step.args, {
            cwd: step.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          const timer = setTimeout(
            () => {
              write(`\n(stopped after ${Math.round((step.timeoutMs ?? 0) / 1000)} s)\n`)
              child.kill('SIGTERM')
            },
            step.timeoutMs ?? 30 * 60_000
          )
          child.stdout.on('data', (d: Buffer) => write(d.toString()))
          child.stderr.on('data', (d: Buffer) => write(d.toString()))
          child.on('error', (err) => write(`\n${err.message}\n`))
          child.on('close', (c) => {
            clearTimeout(timer)
            resolve(c ?? 1)
          })
        })
        job.code = code
        if (code !== 0) {
          write(`\n(exit code ${code})\n`)
          break
        }
      }
      job.status = job.code === 0 ? 'done' : 'failed'
      job.endedAt = Date.now()
      opts.after?.(job)
    })()
    return job
  }

  /** A job that is our own work rather than a program's: `work` writes its output as it goes. */
  track(title: string, key: string, work: (write: (text: string) => void) => Promise<void>): Job {
    const busy = this.running(key)
    if (busy) throw new Error(`already under way: ${busy.title}`)
    const job: Job = {
      id: crypto.randomBytes(6).toString('hex'),
      title,
      key,
      status: 'running',
      startedAt: Date.now(),
      output: '',
    }
    this.jobs.set(job.id, job)
    this.trim()
    const write = (text: string) => {
      job.output = (job.output + text + '\n').slice(-MAX_OUTPUT)
    }
    void work(write)
      .then(() => {
        job.code = 0
        job.status = 'done'
      })
      .catch((err: unknown) => {
        write(`failed: ${err instanceof Error ? err.message : String(err)}`)
        job.code = 1
        job.status = 'failed'
      })
      .finally(() => (job.endedAt = Date.now()))
    return job
  }

  private trim(): void {
    const old = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    while (this.jobs.size > KEEP_JOBS && old.length) this.jobs.delete(old.shift()!.id)
  }
}
