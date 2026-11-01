import fs from 'node:fs'
import path from 'node:path'
import { botEdits, botProblems } from '../botEdits'
import type { Logger } from '../logger'
import { errMsg } from '../util'
import { verifyPassword, weakPassword, type Sessions, type Throttle } from './auth'
import { backupPath, listBackups, serverBackup, stateBackupSteps } from './backups'
import type { LocalServer } from './bds'
import {
  BLUEPRINTS,
  BUILTIN_SPELLS,
  VERBS,
  buildCommand,
  checkLine,
  type CommandSpec,
} from './commands'
import { readJson, since, tail, writeInPlace, writeJson } from './files'
import { HttpError, type Reply, type Request, type Router } from './http'
import type { Jobs } from './jobs'
import { run } from './jobs'
import { checkUrl, serviceInfo, testChat, type OllamaService } from './ollama'
import { SECTIONS, setting } from './settings'
import type { AdminStore } from './store'
import { TOOLS, toolArgs } from './tools'
import type { Division, World } from './world'

export interface Context {
  worlds: World[]
  server?: LocalServer
  store: AdminStore
  sessions: Sessions
  throttle: Throttle
  jobs: Jobs
  backups: string
  log: Logger
}

export const COOKIE = 'gtbk_admin'

const json = (value: unknown, status = 200): Reply => ({ json: value, status })

function body<T = Record<string, unknown>>(req: Request): T {
  if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'a JSON object is needed')
  return req.body as T
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new HttpError(400, `${what}: text needed`)
  return v
}

const PLAYER = /^[A-Za-z0-9_ ]{1,20}$/

export function routes(router: Router, ctx: Context): void {
  const audit = (req: Request, action: string, detail?: unknown) => {
    ctx.store.audit({ ip: req.ip, action, ...(detail !== undefined ? { detail } : {}) })
    ctx.log.info(
      `${req.ip}: ${action}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 300)}` : ''}`
    )
  }
  const world = (id: string | undefined): World => {
    const w = ctx.worlds.find((x) => x.id === id) ?? (id === undefined ? ctx.worlds[0] : undefined)
    if (!w) throw new HttpError(404, `no such world: ${id}`)
    return w
  }
  const server = (): LocalServer => {
    if (!ctx.server) throw new HttpError(404, 'no local server is set up (ADMIN_SERVER)')
    return ctx.server
  }
  const division = (v: unknown): Division => (v === 'army' ? 'army' : 'household')

  // ---- Signing in ----------------------------------------------------------------------------

  router.on(
    'POST',
    '/api/login',
    (req) => {
      const wait = ctx.throttle.wait(req.ip)
      if (wait > 0)
        throw new HttpError(
          429,
          `too many wrong passwords: try again in ${Math.ceil(wait / 1000)} s`
        )
      const password = str(body(req).password, 'password')
      if (!verifyPassword(password, ctx.store.get().passwordHash)) {
        ctx.throttle.failed(req.ip)
        ctx.store.audit({ ip: req.ip, action: 'sign-in refused' })
        throw new HttpError(401, 'wrong password')
      }
      ctx.throttle.succeeded(req.ip)
      const id = ctx.sessions.open(req.ip)
      audit(req, 'signed in')
      return {
        json: { ok: true },
        headers: {
          'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`,
        },
      }
    },
    true
  )
  router.on(
    'POST',
    '/api/logout',
    (req) => {
      ctx.sessions.close(req.cookie(COOKIE))
      return {
        json: { ok: true },
        headers: { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` },
      }
    },
    true
  )
  router.on(
    'GET',
    '/api/me',
    (req) =>
      json({
        signedIn: ctx.sessions.check(req.cookie(COOKIE)),
        firstPassword: ctx.store.get().firstPassword ?? false,
      }),
    true
  )
  router.on('POST', '/api/password', (req) => {
    const b = body(req)
    if (!verifyPassword(str(b.current, 'current'), ctx.store.get().passwordHash))
      throw new HttpError(400, 'the current password is wrong')
    const next = str(b.next, 'new password')
    const weak = weakPassword(next)
    if (weak) throw new HttpError(400, `the new password needs ${weak}`)
    ctx.store.setPassword(next)
    ctx.sessions.closeAll(req.cookie(COOKIE))
    audit(req, 'changed the password')
    return json({ ok: true })
  })

  // ---- Overview ------------------------------------------------------------------------------

  router.on('GET', '/api/overview', async () => {
    const worlds = await Promise.all(
      ctx.worlds.map(async (w) => {
        const containers = await w.containers().catch((err: unknown) => ({ error: errMsg(err) }))
        return {
          id: w.id,
          label: w.label,
          exists: w.exists(),
          server: `${w.env().get('MC_HOST') ?? '127.0.0.1'}:${w.env().get('MC_PORT') ?? '19132'}`,
          ollama: w.env().get('OLLAMA_HOST'),
          containers,
          status: w.status().map((s) => ({
            division: s.division,
            stale: s.stale,
            at: s.at,
            courtWorld: s.courtWorld,
            online: s.bots.filter((b) => b.status === 'spawned').length,
            bots: s.bots.length,
            players: s.players,
            lagMs: s.process.lagMs,
            rssMb: s.process.rssMb,
            magicLeft: s.magicLeft,
          })),
        }
      })
    )
    const presence = readJson(ctx.worlds[0]?.shared('presence.json') ?? '')
    const s = ctx.server
    const local = s && {
      label: s.def.label ?? s.def.service,
      exists: s.exists(),
      running: s.running(),
      players: s.players(),
      version: s.version(),
    }
    return json({
      worlds,
      presence,
      local,
      jobs: ctx.jobs.list().filter((j) => j.status === 'running'),
    })
  })

  // Apart from the rest: a model server far away (or down) must not hold up the overview.
  router.on('GET', '/api/overview/ollama', async () =>
    json(
      await Promise.all(
        ctx.store.get().ollama.map(async (o) => {
          const info = await serviceInfo(o.url)
          return {
            ...o,
            ok: info.ok,
            error: info.error,
            version: info.version,
            loaded: info.loaded,
          }
        })
      )
    )
  )

  // ---- Worlds --------------------------------------------------------------------------------

  router.on('GET', '/api/worlds', () =>
    json(
      ctx.worlds.map((w) => ({
        id: w.id,
        label: w.label,
        dir: w.dir,
        exists: w.exists(),
        divisions: w.divisions(),
      }))
    )
  )

  router.on('GET', '/api/worlds/:w/status', async (req) => {
    const w = world(req.params.w)
    const [containers, version] = await Promise.all([
      w.containers().catch((err: unknown) => ({ error: errMsg(err) })),
      w.version().catch(() => undefined),
    ])
    return json({
      id: w.id,
      label: w.label,
      status: w.status(),
      containers,
      version,
      presence: readJson(w.shared('presence.json')),
      divisions: w.divisions(),
    })
  })

  router.on('GET', '/api/worlds/:w/settings', (req) => {
    const w = world(req.params.w)
    const values = w.env().entries()
    const known = new Set(SECTIONS.flatMap((s) => s.settings.map((x) => x.key)))
    return json({
      sections: SECTIONS,
      values,
      other: Object.keys(values).filter((k) => !known.has(k)),
    })
  })

  router.on('PUT', '/api/worlds/:w/settings', (req) => {
    const w = world(req.params.w)
    const changes = body<{ changes: Record<string, unknown> }>(req).changes ?? {}
    const clean: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(changes)) {
      if (setting(k)?.managed) throw new HttpError(400, `${k} is set by the container`)
      clean[k] = v === null ? undefined : str(v, k)
    }
    w.saveEnv(clean)
    audit(req, `changed ${w.id}'s settings`, Object.keys(clean))
    return json({ ok: true })
  })

  const compose = (
    w: World,
    title: string,
    args: string[],
    extra: Array<{ cmd: string; args: string[] }> = []
  ) =>
    ctx.jobs.start(title, `compose:${w.id}`, [
      ...extra.map((s) => ({ ...s, cwd: w.dir })),
      { cmd: 'docker', args: ['compose', ...args], cwd: w.dir, timeoutMs: 30 * 60_000 },
    ])

  router.on('POST', '/api/worlds/:w/apply', (req) => {
    const w = world(req.params.w)
    audit(req, `applied ${w.id}'s settings (containers made again where changed)`)
    return json(compose(w, `${w.label}: apply settings`, ['up', '-d']))
  })

  router.on('POST', '/api/worlds/:w/rebuild', (req) => {
    const w = world(req.params.w)
    audit(req, `rebuilt ${w.id}`)
    return json(
      compose(
        w,
        `${w.label}: rebuild and restart`,
        ['up', '-d', '--build'],
        [{ cmd: 'git', args: ['-C', w.dir, 'submodule', 'update', '--init'] }]
      )
    )
  })

  router.on('POST', '/api/worlds/:w/containers/:service/:action', async (req) => {
    const w = world(req.params.w)
    const { service, action } = req.params
    if (!['start', 'stop', 'restart'].includes(action))
      throw new HttpError(400, `not an action: ${action}`)
    const services = (await w.containers()).map((c) => c.service)
    if (!services.includes(service)) throw new HttpError(404, `no such service: ${service}`)
    audit(req, `${action} ${w.id}/${service}`)
    return json(compose(w, `${w.label}: ${action} ${service}`, [action, service]))
  })

  router.on('GET', '/api/worlds/:w/docker-logs/:service', async (req) => {
    const w = world(req.params.w)
    const c = (await w.containers()).find((x) => x.service === req.params.service)
    if (!c) throw new HttpError(404, 'no such service')
    const res = await run('docker', ['logs', '--tail', '300', '--timestamps', c.name], {
      timeoutMs: 15_000,
    })
    return json({ text: (res.stdout + res.stderr).slice(-200_000) })
  })

  // Commands to the running court.
  const choices = (w: World) => ({
    spells: [...BUILTIN_SPELLS, ...w.learnedSpells()],
    designs: w.designs(),
  })
  const courtBots = (w: World) =>
    w.bots().map((b) => ({
      name: b.name,
      division: b.division as string | undefined,
      magic: b.magic === true,
      role: b.role,
    }))

  router.on('GET', '/api/worlds/:w/commands', (req) => {
    const w = world(req.params.w)
    return json({ verbs: VERBS, bots: courtBots(w), ...choices(w) })
  })

  router.on('POST', '/api/worlds/:w/commands/preview', (req) => {
    const w = world(req.params.w)
    try {
      return json(buildCommand(body<{ spec: CommandSpec }>(req).spec, courtBots(w), choices(w)))
    } catch (err) {
      return json({ error: errMsg(err) })
    }
  })

  router.on('POST', '/api/worlds/:w/commands', (req) => {
    const w = world(req.params.w)
    const b = body<{ spec?: CommandSpec; line?: string }>(req)
    const built =
      b.line !== undefined
        ? checkLine(str(b.line, 'line'), courtBots(w))
        : buildCommand(b.spec as CommandSpec, courtBots(w), choices(w))
    const day = new Date().toISOString().slice(0, 10)
    const log = w.logPath(built.division, day)
    const from = fs.existsSync(log) ? fs.statSync(log).size : 0
    w.command(built.line, built.division)
    audit(req, `command to ${w.id}/${built.division}`, built.line)
    return json({ ...built, day, from })
  })

  // Logs.
  router.on('GET', '/api/worlds/:w/logs', (req) => {
    const w = world(req.params.w)
    const d = division(req.query.get('division'))
    const days = w.logDays(d)
    const day = req.query.get('day') || days[0]
    if (!day) return json({ days, lines: [], size: 0 })
    const file = w.logPath(d, day)
    const limit = Math.min(Number(req.query.get('limit')) || 500, 5_000)
    const q = (req.query.get('q') ?? '').toLowerCase()
    const level = req.query.get('level') ?? ''
    const bot = req.query.get('bot') ?? ''
    const { text, size } = tail(file, 32 * 1024 * 1024)
    const lines = text.split('\n').filter((l) => {
      if (!l) return false
      if (level && !l.slice(13, 19).includes(level.toUpperCase())) return false
      if (bot && !l.includes(`[app:${bot}`) && !l.includes(`<${bot}>`)) return false
      return !q || l.toLowerCase().includes(q)
    })
    return json({ days, day, lines: lines.slice(-limit), matched: lines.length, size })
  })

  router.on('GET', '/api/worlds/:w/logs/follow', (req) => {
    const w = world(req.params.w)
    const d = division(req.query.get('division'))
    const day = req.query.get('day') || new Date().toISOString().slice(0, 10)
    return json({ day, ...since(w.logPath(d, day), Number(req.query.get('from')) || 0) })
  })

  // The court's state files.
  router.on('GET', '/api/worlds/:w/state', (req) => {
    const w = world(req.params.w)
    const list = (dir: string, prefix = '') => {
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f))
            return { name: prefix + f, sizeKb: Math.round(st.size / 102.4) / 10, at: st.mtimeMs }
          })
      } catch {
        return []
      }
    }
    return json({
      world: list(w.stateDir()),
      designs: list(path.join(w.stateDir(), 'designs'), 'designs/'),
      shared: list(w.sharedDir()),
    })
  })

  router.on('GET', '/api/worlds/:w/state/:name', (req) => {
    const w = world(req.params.w)
    const name = req.params.name
    if (!/^(shared:)?(designs\/)?[\w.-]+\.json$/.test(name))
      throw new HttpError(400, 'not a state file')
    const file = name.startsWith('shared:') ? w.shared(name.slice(7)) : w.state(name)
    const data = readJson(file)
    if (data === undefined) throw new HttpError(404, 'no such file (or not JSON)')
    return json(data)
  })

  router.on('POST', '/api/worlds/:w/presence', (req) => {
    const w = world(req.params.w)
    const target = str(body(req).world, 'world')
    const worlds = ctx.worlds.map((x) => x.env().get('COURT_WORLD')).filter(Boolean)
    if (!worlds.includes(target)) throw new HttpError(400, `not a world of the court: ${target}`)
    const file = w.shared('presence.json')
    const now = readJson<Record<string, unknown>>(file) ?? { kingSeen: {} }
    writeJson(file, { ...now, world: target, at: Date.now(), by: 'the admin' })
    audit(req, `moved the court to ${target}`)
    return json({ ok: true })
  })

  router.on('POST', '/api/worlds/:w/backup', (req) => {
    const w = world(req.params.w)
    fs.mkdirSync(ctx.backups, { recursive: true })
    const { file, steps } = stateBackupSteps(w, ctx.backups)
    audit(req, `backed up ${w.id}'s state`, path.basename(file))
    return json(ctx.jobs.start(`${w.label}: back up the court's state`, `backup:${w.id}`, steps))
  })

  // ---- The court: bots, royals, memories, orders --------------------------------------------

  router.on('GET', '/api/court/bots', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    const bots = w.bots()
    return json({
      world: w.id,
      base: w.baseBots(),
      edits: w.edits(),
      bots,
      problems: botProblems(bots),
      editsFile: w.editsPath(),
      botsFile: w.botsPath(),
    })
  })

  router.on('PUT', '/api/court/bots', (req) => {
    const b = body<{ world?: string; bots: unknown }>(req)
    const w = world(b.world)
    if (
      !Array.isArray(b.bots) ||
      !b.bots.every((x) => x && typeof x === 'object' && !Array.isArray(x))
    )
      throw new HttpError(400, 'bots: a list of bots')
    const wanted = b.bots as Array<Record<string, unknown> & { name: string }>
    const problems = botProblems(wanted)
    if (problems.length) throw new HttpError(400, problems.join('; '))
    if (wanted.length === 0) throw new HttpError(400, 'the court needs at least one bot')
    const edits = botEdits(w.baseBots(), wanted)
    writeJson(w.editsPath(), edits)
    audit(req, 'changed the bots', Object.keys(edits))
    return json({ ok: true, edits })
  })

  router.on('DELETE', '/api/court/bots/edits', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    fs.rmSync(w.editsPath(), { force: true })
    audit(req, "dropped the admin's edits to the bots")
    return json({ ok: true })
  })

  router.on('GET', '/api/court/roster', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    return json({
      world: w.id,
      file: w.courtPath(),
      roster: readJson(w.courtPath()) ?? { realm: 'the realm', charter: '', members: [] },
    })
  })

  router.on('PUT', '/api/court/roster', (req) => {
    const b = body<{ worlds?: string[]; roster: Record<string, unknown> }>(req)
    const r = b.roster
    if (!r || typeof r !== 'object') throw new HttpError(400, 'roster: an object')
    const members = r.members
    if (!Array.isArray(members)) throw new HttpError(400, 'members: a list')
    members.forEach((m: Record<string, unknown>, i) => {
      for (const k of ['player', 'role', 'title', 'address'])
        if (typeof m?.[k] !== 'string' || !(m[k] as string).trim())
          throw new HttpError(400, `member ${i + 1}: ${k} needed`)
      if (!PLAYER.test(m.player as string))
        throw new HttpError(400, `member ${i + 1}: not a player name`)
      if (m.notes !== undefined && typeof m.notes !== 'string')
        throw new HttpError(400, `member ${i + 1}: notes are text`)
    })
    const roster = {
      realm: typeof r.realm === 'string' && r.realm.trim() ? r.realm.trim() : 'the realm',
      charter: typeof r.charter === 'string' ? r.charter.trim() : '',
      members: members.map((m: Record<string, string>) => ({
        player: m.player.trim(),
        role: m.role.trim(),
        title: m.title.trim(),
        address: m.address.trim(),
        ...(m.notes?.trim() ? { notes: m.notes.trim() } : {}),
      })),
    }
    const targets = (b.worlds?.length ? b.worlds : ctx.worlds.map((x) => x.id)).map((id) =>
      world(id)
    )
    for (const w of targets) {
      const file = w.courtPath()
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
      // In place: the court's container mounts this one file.
      writeInPlace(file, JSON.stringify(roster, null, 2) + '\n')
    }
    audit(
      req,
      'changed the royal roster',
      targets.map((t) => t.id)
    )
    return json({ ok: true, worlds: targets.map((t) => t.id) })
  })

  type Fact = { text: string; at: number; private?: boolean; secret?: boolean }
  const memoryFile = (w: World, bot: string) => {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(bot)) throw new HttpError(400, 'not a bot')
    return w.shared(`memory-${bot.toLowerCase()}.json`)
  }

  router.on('GET', '/api/court/memory', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    return json(
      w.bots().map((b) => {
        const m = readJson<Record<string, Fact[]>>(memoryFile(w, b.name)) ?? {}
        return {
          bot: b.name,
          subjects: Object.keys(m).length,
          facts: Object.values(m).reduce((n, f) => n + f.length, 0),
        }
      })
    )
  })

  router.on('GET', '/api/court/memory/:bot', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    return json(readJson(memoryFile(w, req.params.bot)) ?? {})
  })

  router.on('DELETE', '/api/court/memory/:bot', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    const b = body<{ subject: string; at: number; text: string }>(req)
    const file = memoryFile(w, req.params.bot)
    const m = readJson<Record<string, Fact[]>>(file) ?? {}
    const facts = m[b.subject] ?? []
    const kept = facts.filter((f) => !(f.at === b.at && f.text === b.text))
    if (kept.length === facts.length) throw new HttpError(404, 'no such fact (changed meanwhile?)')
    if (kept.length) m[b.subject] = kept
    else delete m[b.subject]
    writeJson(file, m)
    audit(req, `made ${req.params.bot} forget a fact about ${b.subject}`, b.text)
    return json({ ok: true })
  })

  const ordersFile = (w: World, bot: string) => {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(bot)) throw new HttpError(400, 'not a bot')
    return w.shared(`orders-${bot.toLowerCase()}.json`)
  }

  router.on('GET', '/api/court/orders', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    return json({
      bots: w.bots().map((b) => ({
        bot: b.name,
        ...(readJson<object>(ordersFile(w, b.name)) ?? { orders: [], reports: [] }),
      })),
      rules: readJson(w.shared('rules.json')) ?? { rules: [] },
    })
  })

  router.on('DELETE', '/api/court/orders/:bot/:id', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    const file = ordersFile(w, req.params.bot)
    const book = readJson<{ orders: Array<{ id: string; text: string }> }>(file)
    const order = book?.orders.find((o) => o.id === req.params.id)
    if (!book || !order) throw new HttpError(404, 'no such order')
    writeJson(file, { ...book, orders: book.orders.filter((o) => o !== order) })
    audit(req, `released ${req.params.bot} from an order`, order.text)
    return json({ ok: true })
  })

  router.on('DELETE', '/api/court/rules/:id', (req) => {
    const w = world(req.query.get('world') ?? undefined)
    const file = w.shared('rules.json')
    const data = readJson<{ rules: Array<{ id: string; text: string }> }>(file)
    const rule = data?.rules.find((r) => r.id === req.params.id)
    if (!data || !rule) throw new HttpError(404, 'no such rule')
    writeJson(file, { ...data, rules: data.rules.filter((r) => r !== rule) })
    audit(req, 'took away a rule', rule.text)
    return json({ ok: true })
  })

  // ---- Ollama --------------------------------------------------------------------------------

  router.on('GET', '/api/ollama', async () => {
    const services = ctx.store.get().ollama
    const urls = [
      ...new Set([
        ...services.map((s) => checkUrl(s.url)),
        ...ctx.worlds
          .map((w) => w.env().get('OLLAMA_HOST'))
          .filter((u): u is string => Boolean(u))
          .map(checkUrl),
      ]),
    ]
    const infos = await Promise.all(urls.map((u) => serviceInfo(u)))
    const roles = ['OLLAMA_MODEL', 'OLLAMA_ORDER_MODEL', 'OLLAMA_MEMORY_MODEL', 'OVERLORD_MODEL']
    return json({
      services,
      infos,
      worlds: ctx.worlds.map((w) => {
        const env = w.env()
        return {
          id: w.id,
          label: w.label,
          host: env.get('OLLAMA_HOST'),
          models: Object.fromEntries(roles.map((r) => [r, env.get(r) ?? ''])),
        }
      }),
    })
  })

  router.on('PUT', '/api/ollama/services', (req) => {
    const list = body<{ services: OllamaService[] }>(req).services
    if (!Array.isArray(list)) throw new HttpError(400, 'services: a list')
    const services = list.map((s, i) => {
      const name = str(s?.name, `service ${i + 1} name`).trim()
      if (!name || name.length > 40)
        throw new HttpError(400, `service ${i + 1}: a name of at most 40 characters`)
      return { name, url: checkUrl(str(s?.url, `service ${i + 1} url`)) }
    })
    ctx.store.setOllama(services)
    audit(req, 'changed the Ollama servers', services)
    return json({ ok: true })
  })

  router.on('POST', '/api/ollama/test', async (req) => {
    const b = body(req)
    audit(req, 'test chat', { url: b.url, model: b.model })
    return json(await testChat(str(b.url, 'url'), str(b.model, 'model'), str(b.prompt, 'prompt')))
  })

  // ---- The local Bedrock server --------------------------------------------------------------

  router.on('GET', '/api/server', () => {
    const s = server()
    const exists = s.exists()
    return json({
      def: s.def,
      exists,
      running: exists && s.running(),
      players: exists ? s.players() : [],
      version: exists ? s.version() : undefined,
      control: s.lastControl(),
      properties: exists ? s.properties() : [],
    })
  })

  router.on('POST', '/api/server/control', async (req) => {
    const action = str(body(req).action, 'action')
    audit(req, `server: ${action}`)
    return json(await server().control(action))
  })

  router.on('POST', '/api/server/console', (req) => {
    const s = server()
    const command = str(body(req).command, 'command')
    const from = s.console().size
    s.send(command)
    audit(req, 'server console', command)
    return json({ ok: true, from })
  })

  router.on('GET', '/api/server/console', (req) => {
    const from = req.query.get('from')
    return json(server().console(from === null ? undefined : Number(from) || 0))
  })

  router.on('PUT', '/api/server/properties', (req) => {
    const changes = body<{ changes: Record<string, string> }>(req).changes ?? {}
    for (const [k, v] of Object.entries(changes)) str(v, k)
    server().setProperties(changes)
    audit(req, 'changed server.properties', changes)
    return json({ ok: true, note: 'The server reads these when it starts: restart it.' })
  })

  router.on('POST', '/api/server/backup', (req) => {
    const s = server()
    fs.mkdirSync(ctx.backups, { recursive: true })
    audit(req, "backed up the server's world")
    return json(
      ctx.jobs.track(
        `${s.def.label ?? s.def.service}: back up the world`,
        'backup:server',
        async (write) => {
          const file = await serverBackup(s, ctx.backups, write)
          write(`written: ${path.basename(file)}`)
        }
      )
    )
  })

  // ---- Tools, jobs and backups ---------------------------------------------------------------

  router.on('GET', '/api/tools', () =>
    json({
      tools: TOOLS,
      worlds: ctx.worlds.map((w) => ({
        id: w.id,
        label: w.label,
        designs: w.designs(),
        bots: w.bots().map((b) => b.name),
        blueprints: BLUEPRINTS,
      })),
    })
  )

  router.on('POST', '/api/tools/:id', async (req) => {
    const tool = TOOLS.find((t) => t.id === req.params.id)
    if (!tool) throw new HttpError(404, 'no such tool')
    const b = body<{ world: string; args: Record<string, string | string[]> }>(req)
    const w = world(b.world)
    const args = toolArgs(tool, b.args ?? {}, {
      designs: w.designs(),
      bots: w.bots().map((x) => x.name),
      blueprints: BLUEPRINTS,
    })
    const court = (await w.containers()).find((c) => c.service === 'court' && c.state === 'running')
    if (!court)
      throw new HttpError(409, `${w.label}'s court is not running: the tools run in its container`)
    let file: string | undefined
    if (tool.picture) {
      const name = `admin/renders/${tool.id}-${Date.now()}.png`
      fs.mkdirSync(path.dirname(w.state(name)), { recursive: true })
      args.splice(1, 0, `.state/${name}`)
      file = w.state(name)
    }
    audit(req, `tool ${tool.id} in ${w.id}`, args)
    return json(
      ctx.jobs.start(
        `${tool.label} (${w.label})`,
        `tool:${w.id}`,
        [
          {
            cmd: 'docker',
            args: [
              'exec',
              '-w',
              '/app',
              court.name,
              'corepack',
              'pnpm',
              'exec',
              'tsx',
              `scripts/${tool.script}`,
              ...args,
            ],
            timeoutMs: 15 * 60_000,
          },
        ],
        file ? { file } : {}
      )
    )
  })

  router.on('GET', '/api/jobs', () => json(ctx.jobs.list()))
  router.on('GET', '/api/jobs/:id', (req) => {
    const job = ctx.jobs.get(req.params.id)
    if (!job) throw new HttpError(404, 'no such job')
    return json(job)
  })
  router.on('GET', '/api/jobs/:id/file', (req) => {
    const job = ctx.jobs.get(req.params.id)
    if (!job?.file || !fs.existsSync(job.file)) throw new HttpError(404, 'no picture')
    return { file: job.file, type: 'image/png' }
  })

  router.on('GET', '/api/backups', () =>
    json({ dir: ctx.backups, backups: listBackups(ctx.backups) })
  )
  router.on('GET', '/api/backups/:name', (req) => ({
    file: backupPath(ctx.backups, req.params.name),
    type: 'application/gzip',
    download: req.params.name,
  }))
  router.on('DELETE', '/api/backups/:name', (req) => {
    fs.rmSync(backupPath(ctx.backups, req.params.name))
    audit(req, 'deleted a backup', req.params.name)
    return json({ ok: true })
  })

  // ---- The admin itself ----------------------------------------------------------------------

  router.on('GET', '/api/admin', () =>
    json({
      worlds: ctx.worlds.map((w) => ({
        ...w.def,
        label: w.label,
        mounted: w.exists(),
        shared: w.sharedDir(),
      })),
      server: ctx.server ? { ...ctx.server.def, mounted: ctx.server.exists() } : undefined,
      data: ctx.store.dir,
      backups: ctx.backups,
      firstPassword: ctx.store.get().firstPassword ?? false,
    })
  )
  router.on('GET', '/api/audit', () => json(ctx.store.auditLog()))
}
