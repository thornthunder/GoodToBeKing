import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Jobs, type Job } from './jobs'

function finished(jobs: Jobs, job: Job): Promise<Job> {
  return new Promise((resolve) => {
    const check = () => {
      const j = jobs.get(job.id)
      if (j && j.status !== 'running') resolve(j)
      else setTimeout(check, 20)
    }
    check()
  })
}

describe('jobs', () => {
  it("write a step's output to a file when asked (a database dump)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtbk-jobs-'))
    try {
      const jobs = new Jobs()
      const out = path.join(dir, 'dump')
      const job = await finished(
        jobs,
        jobs.start('dump', 'dump', [
          { cmd: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(5000))"], out },
        ])
      )
      expect(job.status).toBe('done')
      expect(fs.readFileSync(out, 'utf8')).toBe('x'.repeat(5000))
      expect(job.output).not.toContain('xxxx')
      expect(job.output).toContain('KB written to')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leave no file behind when the step fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtbk-jobs-'))
    try {
      const jobs = new Jobs()
      const out = path.join(dir, 'dump')
      const job = await finished(
        jobs,
        jobs.start('dump', 'dump', [
          {
            cmd: process.execPath,
            args: ['-e', "process.stdout.write('half'); process.exit(3)"],
            out,
          },
        ])
      )
      expect(job.status).toBe('failed')
      expect(fs.existsSync(out)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
