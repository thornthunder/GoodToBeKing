import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/**
 * The admin's HTTP plumbing: routes, JSON in and out, the session cookie, and the page's files.
 * Every change must carry the header X-Admin (the page sends it; a page on another site cannot
 * without the server's leave, which it never gives), and the cookie is SameSite=Strict.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface Request {
  method: string
  path: string
  query: URLSearchParams
  params: Record<string, string>
  body: unknown
  ip: string
  cookie(name: string): string | undefined
  raw: http.IncomingMessage
}

export type Reply =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { file: string; type: string; download?: string }

type Handler = (req: Request) => Promise<Reply> | Reply

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
  open: boolean
}

const MAX_BODY = 2 * 1024 * 1024

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

export class Router {
  private readonly routes: Route[] = []

  /** A route; ":name" in the path is a parameter. `open`: no sign-in needed. */
  on(method: string, route: string, handler: Handler, open = false): void {
    const keys: string[] = []
    const pattern = new RegExp(
      '^' +
        route.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
          keys.push(k)
          return '([^/]+)'
        }) +
        '$'
    )
    this.routes.push({ method, pattern, keys, handler, open })
  }

  find(method: string, p: string): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const m = route.pattern.exec(p)
      if (!m) continue
      const params: Record<string, string> = {}
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
      return { route, params }
    }
    return undefined
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too much'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export interface ServerOptions {
  router: Router
  /** The page's own files (index.html, app.js, app.css). */
  uiDir: string
  /** Whether the request's session is good. */
  signedIn: (req: Request) => boolean
  log: (text: string) => void
}

export function createServer(opts: ServerOptions): http.Server {
  return http.createServer((raw, res) => {
    void (async () => {
      const url = new URL(raw.url ?? '/', 'http://admin')
      const method = raw.method ?? 'GET'
      const send = (status: number, body: string | Buffer, headers: Record<string, string>) => {
        res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
        res.end(body)
      }
      const sendJson = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        send(status, JSON.stringify(value), {
          'Content-Type': 'application/json; charset=utf-8',
          ...headers,
        })
      try {
        // The page itself.
        if (method === 'GET' && !url.pathname.startsWith('/api/')) {
          const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
          const file = path.resolve(opts.uiDir, name)
          if (
            !file.startsWith(path.resolve(opts.uiDir) + path.sep) ||
            !fs.existsSync(file) ||
            !TYPES[path.extname(file)]
          )
            return send(404, 'not found', { 'Content-Type': 'text/plain' })
          return send(200, fs.readFileSync(file), { 'Content-Type': TYPES[path.extname(file)] })
        }
        const found = opts.router.find(method, url.pathname)
        if (!found) return sendJson(404, { error: 'no such thing' })
        const jar = cookies(raw.headers.cookie)
        const req: Request = {
          method,
          path: url.pathname,
          query: url.searchParams,
          params: found.params,
          body: undefined,
          ip: raw.socket.remoteAddress ?? '?',
          cookie: (name) => jar[name],
          raw,
        }
        if (method !== 'GET') {
          if (raw.headers['x-admin'] !== '1')
            return sendJson(403, { error: 'missing X-Admin header' })
          req.body = await readBody(raw)
        }
        if (!found.route.open && !opts.signedIn(req))
          return sendJson(401, { error: 'sign in first' })
        const reply = await found.route.handler(req)
        if ('file' in reply) {
          const headers: Record<string, string> = { 'Content-Type': reply.type }
          if (reply.download)
            headers['Content-Disposition'] =
              `attachment; filename="${reply.download.replace(/[^\w.-]/g, '_')}"`
          res.writeHead(200, { ...SECURITY_HEADERS, ...headers })
          fs.createReadStream(reply.file).pipe(res)
          return
        }
        sendJson(reply.status ?? 200, reply.json, reply.headers)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        const message = err instanceof Error ? err.message : String(err)
        if (!(err instanceof HttpError)) opts.log(`${method} ${url.pathname}: ${message}`)
        sendJson(status, { error: message })
      }
    })()
  })
}
