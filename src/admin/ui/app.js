// The admin page: sign-in, the sidebar, and which page shows for each address (#/...).
import {
  ago,
  badge,
  card,
  every,
  fill,
  get,
  h,
  kv,
  post,
  stat,
  stateBadge,
  stopTimers,
  table,
  toast,
  until,
} from './lib.js'
import { worldPage } from './world.js'
import { botsPage, memoryPage, ordersPage, rosterPage } from './court.js'
import { ollamaPage, serversPage } from './services.js'
import { adminPage, backupsPage, containersPage, jobsPage, toolsPage } from './ops.js'

const root = document.getElementById('root')
let worlds = []

const PAGES = {
  '': overviewPage,
  world: worldPage,
  bots: botsPage,
  roster: rosterPage,
  memory: memoryPage,
  orders: ordersPage,
  servers: serversPage,
  ollama: ollamaPage,
  containers: containersPage,
  tools: toolsPage,
  backups: backupsPage,
  jobs: jobsPage,
  admin: adminPage,
}

async function start() {
  const me = await get('/api/me').catch(() => ({ signedIn: false }))
  if (!me.signedIn) return showLogin()
  worlds = await get('/api/worlds')
  showApp(me)
}

function showLogin(message) {
  stopTimers()
  const password = h('input', {
    type: 'password',
    placeholder: 'Password',
    autocomplete: 'current-password',
    required: true,
  })
  const error = h('div', { class: 'notice bad hidden' })
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault()
        try {
          await post('/api/login', { password: password.value })
          await start()
        } catch (err) {
          fill(error, err.message)
          error.classList.remove('hidden')
        }
      },
    },
    h('h1', {}, h('span', { class: 'crown' }, '♛ '), 'GoodToBeKing'),
    h('div', { class: 'muted' }, 'The court’s admin'),
    message ? h('div', { class: 'notice warn' }, message) : null,
    error,
    password,
    h('button', { class: 'primary', type: 'submit' }, 'Sign in')
  )
  fill(root, h('div', { class: 'login' }, form))
  password.focus()
}

window.addEventListener('signed-out', () => showLogin('Signed out: sign in again.'))

function navLink(href, label, extra) {
  return h('a', { href, 'data-path': href }, extra, label)
}

function showApp(me) {
  const main = h('div')
  const side = h(
    'nav',
    { class: 'side' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'crown' }, '♛'),
      'GoodToBeKing',
      h('small', {}, 'The court’s admin')
    ),
    h(
      'div',
      { class: 'nav' },
      navLink('#/', 'Overview'),
      h('div', { class: 'nav-group' }, 'Worlds'),
      worlds.map((w) =>
        navLink(`#/world/${w.id}`, w.label, h('span', { class: 'dot', 'data-world': w.id }))
      ),
      h('div', { class: 'nav-group' }, 'Court'),
      navLink('#/bots', 'Bots'),
      navLink('#/roster', 'Royal family'),
      navLink('#/memory', 'Memories'),
      navLink('#/orders', 'Orders & rules'),
      h('div', { class: 'nav-group' }, 'Services'),
      navLink('#/servers', 'Game servers'),
      navLink('#/ollama', 'Ollama'),
      h('div', { class: 'nav-group' }, 'Operations'),
      navLink('#/containers', 'Containers & deploy'),
      navLink('#/tools', 'Tools'),
      navLink('#/backups', 'Backups'),
      navLink('#/jobs', 'Jobs'),
      h('div', { class: 'nav-group' }, 'Admin'),
      navLink('#/admin', 'Password & audit')
    ),
    h('div', { class: 'grow' }),
    h(
      'button',
      {
        class: 'signout',
        onclick: async () => {
          await post('/api/logout')
          showLogin()
        },
      },
      'Sign out'
    )
  )
  const menu = h(
    'button',
    { class: 'menu-button', onclick: () => side.classList.toggle('open') },
    '☰ Menu'
  )
  fill(root, h('div', { class: 'app' }, side, h('main', { class: 'main' }, menu, main)))
  const route = () => {
    stopTimers()
    side.classList.remove('open')
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
    const page = PAGES[parts[0]] ?? overviewPage
    for (const a of side.querySelectorAll('a[data-path]')) {
      const p = a.getAttribute('data-path')
      a.classList.toggle('active', p === '#/' ? parts[0] === '' : location.hash.startsWith(p))
    }
    fill(main, h('p', { class: 'muted' }, 'Loading…'))
    Promise.resolve(page(main, parts.slice(1), { worlds })).catch((err) => {
      fill(main, h('div', { class: 'notice bad' }, err.message))
    })
    window.scrollTo(0, 0)
  }
  window.onhashchange = route
  route()
  if (me.firstPassword)
    toast('The password is still the first one made: change it under Password & audit.', 'bad')
  // The world dots in the sidebar: green when every mind writes its status, amber when stale.
  every(15_000, async () => {
    for (const w of worlds) {
      const dot = side.querySelector(`[data-world="${w.id}"]`)
      const s = await get(`/api/worlds/${w.id}/status`).catch(() => undefined)
      const minds = s?.status ?? []
      dot.className = `dot ${!minds.length ? '' : minds.every((m) => !m.stale) ? 'ok' : minds.some((m) => !m.stale) ? 'warn' : 'bad'}`
    }
  })
}

// ---- Overview --------------------------------------------------------------------------------

async function overviewPage(main) {
  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      h('h1', {}, 'Overview'),
      h('p', {}, 'Every world’s court, the local server and the model servers at a glance.')
    )
  )
  const body = h('div', { class: 'stack' })
  const models = h('div', { class: 'grid' })
  fill(main, head, body, h('h2', {}, 'Model servers'), models)
  // The model servers apart: one far away or down must not hold up the rest.
  every(30_000, async () => fill(models, (await get('/api/overview/ollama')).map(ollamaCard)))
  every(10_000, async () => {
    const o = await get('/api/overview')
    const courtIn = o.presence?.world
    fill(
      body,
      courtIn
        ? h(
            'div',
            { class: 'notice' },
            `The court is in the ${courtIn} world (called there ${ago(o.presence.at)}${o.presence.by ? ` by ${o.presence.by}` : ''}). Merlin is in every world.`
          )
        : null,
      o.jobs.length
        ? card(
            'Under way',
            table(
              [
                ['Job', (j) => h('a', { href: '#/jobs' }, j.title)],
                ['Started', (j) => ago(j.startedAt)],
              ],
              o.jobs
            )
          )
        : null,
      h('div', { class: 'grid' }, o.worlds.map(worldCard), o.local ? localCard(o.local) : null)
    )
  })
}

function worldCard(w) {
  const containers = Array.isArray(w.containers) ? w.containers : []
  const players = [...new Map(w.status.flatMap((s) => s.players).map((p) => [p.name, p])).values()]
  return card(
    h('a', { href: `#/world/${w.id}` }, w.label),
    h('div', { class: 'sub' }, `Plays on ${w.server}`),
    !w.exists
      ? h('div', { class: 'notice bad' }, 'The checkout is not mounted into the admin.')
      : null,
    w.containers.error ? h('div', { class: 'notice bad' }, w.containers.error) : null,
    h(
      'div',
      { class: 'row' },
      containers.map((c) => h('span', {}, `${c.service} `, stateBadge(c.state)))
    ),
    h('h3', {}, 'Minds'),
    w.status.length
      ? table(
          [
            ['Mind', (s) => s.division],
            ['Bots online', (s) => `${s.online} / ${s.bots}`],
            [
              'Status',
              (s) => (s.stale ? badge(`silent ${ago(s.at)}`, 'bad') : badge('live', 'ok')),
            ],
            ['Lag', (s) => `${s.lagMs} ms`],
            ['Memory', (s) => `${s.rssMb} MB`],
          ],
          w.status
        )
      : h(
          'p',
          { class: 'muted' },
          'No status yet (the court writes one every few seconds once it runs this version).'
        ),
    h('h3', {}, 'Players online'),
    players.length
      ? h(
          'div',
          { class: 'chips' },
          players.map((p) =>
            h('span', { class: 'chip' }, p.name, p.title ? h('b', {}, p.title) : null)
          )
        )
      : h('p', { class: 'muted' }, 'Nobody.')
  )
}

function localCard(s) {
  return card(
    h('a', { href: '#/servers' }, s.label),
    kv([
      ['State', s.running ? badge('running', 'ok') : badge('not running', 'bad')],
      ['Version', s.version],
      ['Players', s.players.length ? s.players.join(', ') : 'nobody'],
    ])
  )
}

function ollamaCard(o) {
  return card(
    h('a', { href: '#/ollama' }, `Ollama: ${o.name}`),
    h('div', { class: 'sub' }, o.url),
    o.ok ? null : h('div', { class: 'notice bad' }, o.error),
    o.ok
      ? h(
          'div',
          {},
          stat(o.version ?? '?', 'version'),
          stat(o.loaded.length, 'models loaded'),
          table(
            [
              ['Loaded', (m) => m.name],
              ['VRAM', (m) => `${m.vramGb} GB`],
              ['Stays', (m) => (m.expiresAt ? until(Date.parse(m.expiresAt)) : '—')],
            ],
            o.loaded,
            { empty: 'No model loaded.' }
          )
        )
      : null
  )
}

void start()
