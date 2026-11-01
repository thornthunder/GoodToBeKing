import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'
import { errMsg } from '../util'
import { COOKIE, routes } from './api'
import { Sessions, Throttle } from './auth'
import { LocalServer } from './bds'
import { Router, createServer } from './http'
import { Jobs } from './jobs'
import { AdminStore } from './store'
import { World } from './world'

/**
 * The court's admin: a web page (and its API) to watch and steer the courts of every world, their
 * bots, the Ollama servers, the local Bedrock server and the court's tools. Runs in its own
 * container (compose.admin.yaml) with each world's checkout mounted at its host path and the
 * Docker socket, so it can run compose as one would on the host. Settings (all from env):
 *   ADMIN_PORT (8080), ADMIN_HOST (0.0.0.0), ADMIN_DATA (its own folder: password, audit log),
 *   ADMIN_WORLDS ("dev=/home/jean/court-test,creative=/home/jean/GoodToBeKing"),
 *   ADMIN_SERVER ("bds-test=/home/jean/testserver", a systemd service and its folder),
 *   ADMIN_SERVER_WORLD (the world that plays on it), ADMIN_BACKUPS (a folder),
 *   ADMIN_OLLAMA ("Ava=http://ava:11434", the servers it knows at first start),
 *   ADMIN_PASSWORD (the password at first start; else one is made and put in ADMIN_DATA).
 */
function pairs(value: string | undefined): Array<[string, string]> {
  return (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=')
      if (i <= 0) throw new Error(`"${p}" must be name=value`)
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    })
}

function uiDir(): string {
  // From dist/admin (the image) or src/admin (tsx): the page's files stay in src/admin/ui.
  for (const dir of [path.join(__dirname, 'ui'), path.resolve(__dirname, '../../src/admin/ui')])
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir
  throw new Error('the admin page (src/admin/ui) is missing')
}

function main(): void {
  const log = createLogger('admin')
  const worlds = pairs(process.env.ADMIN_WORLDS).map(([id, dir]) => new World({ id, dir }))
  if (!worlds.length) throw new Error('ADMIN_WORLDS names no world (id=folder,...)')
  for (const w of worlds)
    if (!w.exists()) log.warn(`${w.id}: no checkout at ${w.dir} (is it mounted?)`)
  const [service, dir] = pairs(process.env.ADMIN_SERVER)[0] ?? []
  const server =
    service && dir
      ? new LocalServer({
          service,
          dir,
          label: `Local server (${service})`,
          world: process.env.ADMIN_SERVER_WORLD,
        })
      : undefined
  const store = new AdminStore(
    path.resolve(process.env.ADMIN_DATA || '.admin'),
    {
      ollama: pairs(process.env.ADMIN_OLLAMA).map(([name, url]) => ({ name, url })),
      password: process.env.ADMIN_PASSWORD || undefined,
    },
    (t) => log.warn(t)
  )
  const sessions = new Sessions()
  const router = new Router()
  routes(router, {
    worlds,
    server,
    store,
    sessions,
    throttle: new Throttle(),
    jobs: new Jobs(),
    backups: path.resolve(process.env.ADMIN_BACKUPS || path.join(store.dir, 'backups')),
    log,
  })
  const port = Number(process.env.ADMIN_PORT) || 8080
  const host = process.env.ADMIN_HOST || '0.0.0.0'
  createServer({
    router,
    uiDir: uiDir(),
    signedIn: (req) => sessions.check(req.cookie(COOKIE)),
    log: (t) => log.warn(t),
  }).listen(port, host, () => {
    log.info(
      `the admin listens on http://${host}:${port} for ${worlds.map((w) => w.id).join(', ')}`
    )
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0))
}

try {
  main()
} catch (err) {
  console.error(`the admin could not start: ${errMsg(err)}`)
  process.exit(1)
}
