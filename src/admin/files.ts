import fs from 'node:fs'
import path from 'node:path'

/** Reading and writing the court's files from the admin, safely. */

/** A JSON file, or undefined when it is missing or broken. */
export function readJson<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Write a file whole: to a temporary file beside it, then renamed over it, so the court never
 * reads half of it. The court re-reads files whose time changed (memories, orders, household).
 */
export function writeWhole(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.admin-${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function writeJson(file: string, data: unknown): void {
  writeWhole(file, JSON.stringify(data, null, 2) + '\n')
}

/**
 * Write over a file where it stands (same inode). For files a container mounts one by one
 * (config/court.json): a renamed file would leave the container reading the old one.
 */
export function writeInPlace(file: string, text: string): void {
  fs.writeFileSync(file, text)
}

/** Append one line (a command for the court), creating the file if need be. */
export function appendLine(file: string, line: string): void {
  if (/[\r\n]/.test(line)) throw new Error('one line only')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, line + '\n')
}

/** The last `bytes` of a file, starting at a whole line; and the file's size. */
export function tail(file: string, bytes: number): { text: string; size: number } {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text, size }
  } catch {
    return { text: '', size: 0 }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** What was added to a file since `from` (a size the page saw before), at most `max` bytes. */
export function since(
  file: string,
  from: number,
  max = 256 * 1024
): { text: string; size: number } {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    // A new day's file, or one that was cut: from its start.
    const start = from > size ? 0 : Math.max(from, size - max)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return { text: buf.toString('utf8'), size }
  } catch {
    return { text: '', size: 0 }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** `name` inside `dir` and nowhere else (no "..", no absolute paths). */
export function inside(dir: string, name: string): string {
  const full = path.resolve(dir, name)
  const root = path.resolve(dir)
  if (full !== root && !full.startsWith(root + path.sep))
    throw new Error(`not inside ${dir}: ${name}`)
  return full
}
