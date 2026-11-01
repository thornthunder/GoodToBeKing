// Running the court: containers and deploys, the court's tools, backups, jobs, and the admin.
import {
  act,
  ago,
  badge,
  button,
  card,
  confirmFirst,
  del,
  every,
  fill,
  get,
  h,
  input,
  jobView,
  kv,
  post,
  select,
  stateBadge,
  table,
  when,
} from './lib.js'

// ---- Containers and deploy -------------------------------------------------------------------

export async function containersPage(main, _rest, { worlds }) {
  const body = h('div', { class: 'stack' })
  const jobBox = h('div')
  const logBox = h('div')
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Containers & deploy'),
        h(
          'p',
          {},
          'Each world’s court runs in two containers (the household’s mind and the army’s). Stopping one disconnects its bots properly.'
        )
      )
    ),
    jobBox,
    body,
    logBox
  )
  const run = (title, fn) =>
    act(
      confirmFirst(title, async () => {
        fill(jobBox, card(null, jobView(await fn())))
        jobBox.scrollIntoView({ behavior: 'smooth' })
      })
    )
  every(10_000, async () => {
    const all = await Promise.all(
      worlds.map((w) => get(`/api/worlds/${w.id}/status`).then((s) => ({ w, s })))
    )
    fill(
      body,
      all.map(({ w, s }) =>
        card(
          w.label,
          s.version
            ? kv([
                ['Checkout', w.dir],
                [
                  'Code',
                  `${s.version.commit} ${s.version.subject} (${ago(Date.parse(s.version.date))})`,
                ],
                ['Local changes', s.version.dirty.length ? s.version.dirty.join(', ') : 'none'],
              ])
            : null,
          s.containers.error
            ? h('div', { class: 'notice bad' }, s.containers.error)
            : table(
                [
                  ['Service', (c) => h('b', {}, c.service)],
                  ['Container', (c) => h('span', { class: 'mono' }, c.name)],
                  ['State', (c) => stateBadge(c.state)],
                  ['Status', (c) => c.status],
                  [
                    '',
                    (c) =>
                      h(
                        'div',
                        { class: 'row' },
                        c.state === 'running'
                          ? [
                              button(
                                'Restart',
                                run(`Restart ${c.name}? Its bots reconnect.`, () =>
                                  post(`/api/worlds/${w.id}/containers/${c.service}/restart`)
                                ),
                                'small'
                              ),
                              button(
                                'Stop',
                                run(
                                  `Stop ${c.name}? Its bots leave the server until it is started again.`,
                                  () => post(`/api/worlds/${w.id}/containers/${c.service}/stop`)
                                ),
                                'small danger'
                              ),
                            ]
                          : button(
                              'Start',
                              run(`Start ${c.name}?`, () =>
                                post(`/api/worlds/${w.id}/containers/${c.service}/start`)
                              ),
                              'small'
                            ),
                        button(
                          'Docker log',
                          act(async () => {
                            const r = await get(`/api/worlds/${w.id}/docker-logs/${c.service}`)
                            fill(
                              logBox,
                              card(`${c.name}: docker log`, h('pre', { class: 'log' }, r.text))
                            )
                            logBox.scrollIntoView({ behavior: 'smooth' })
                          }),
                          'small'
                        )
                      ),
                  ],
                ],
                s.containers
              ),
          h(
            'div',
            { class: 'row' },
            button(
              'Apply settings',
              run(
                `Make ${w.label}’s containers again where their settings changed? Their bots reconnect.`,
                () => post(`/api/worlds/${w.id}/apply`)
              )
            ),
            button(
              'Rebuild & restart',
              run(
                `Rebuild ${w.label}’s court from its checkout (git submodule update, docker compose up -d --build)? Takes a few minutes; the bots reconnect.`,
                () => post(`/api/worlds/${w.id}/rebuild`)
              ),
              'primary'
            ),
            button(
              'Back up its state',
              act(
                async () =>
                  fill(jobBox, card(null, jobView(await post(`/api/worlds/${w.id}/backup`)))),
                'Backing up…'
              )
            )
          ),
          h(
            'p',
            { class: 'small muted' },
            'New code reaches a checkout by git push from the development machine; Rebuild then builds and starts it.'
          )
        )
      )
    )
  })
}

// ---- Tools -----------------------------------------------------------------------------------

export async function toolsPage(main, _rest, { worlds }) {
  const data = await get('/api/tools')
  const worldSel = select(
    worlds.map((w) => [w.id, w.label]),
    worlds[0]?.id
  )
  const toolsBox = h('div', { class: 'grid wide' })
  const jobBox = h('div')
  const show = () => {
    const w = data.worlds.find((x) => x.id === worldSel.value)
    fill(
      toolsBox,
      data.tools.map((t) => {
        const inputs = {}
        const fields = t.args.map((a) => {
          let el
          if (a.kind === 'design') el = select(w.designs, w.designs[0])
          else if (a.kind === 'bot') el = select(['', ...w.bots], '')
          else if (a.kind === 'blueprint') el = select(w.blueprints, w.blueprints[0])
          else if (a.many) el = h('textarea', { placeholder: 'one per line' })
          else
            el = input({
              class: a.kind === 'int' ? 'num' : '',
              size: a.kind === 'int' ? 6 : 26,
              placeholder: a.optional ? 'optional' : '',
            })
          inputs[a.name] = [el, a]
          return h('label', {}, a.label + (a.optional ? '' : ' *'), el)
        })
        const runTool = act(async () => {
          if (t.warning && !window.confirm(t.warning)) return
          const args = Object.fromEntries(
            Object.entries(inputs).map(([k, [el, a]]) => [
              k,
              a.many
                ? el.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : el.value,
            ])
          )
          fill(jobBox, card(null, jobView(await post(`/api/tools/${t.id}`, { world: w.id, args }))))
          jobBox.scrollIntoView({ behavior: 'smooth' })
        })
        return card(
          t.label,
          h('div', { class: 'sub' }, t.help),
          t.warning ? h('div', { class: 'notice warn small' }, t.warning) : null,
          h('div', { class: 'fields' }, fields),
          h(
            'div',
            { class: 'row end' },
            h('span', { class: 'muted small mono' }, `scripts/${t.script}`),
            button('Run', runTool, 'primary')
          )
        )
      })
    )
  }
  worldSel.addEventListener('change', show)
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Tools'),
        h(
          'p',
          {},
          'The court’s own scripts, run in the world’s court container. Those that look at the world join its server as Surveyor (the court ignores that name); one tool at a time per world.'
        )
      ),
      h(
        'div',
        { class: 'actions' },
        h('label', { class: 'row' }, h('span', { class: 'muted' }, 'World'), worldSel)
      )
    ),
    jobBox,
    toolsBox
  )
  show()
}

// ---- Backups ---------------------------------------------------------------------------------

export async function backupsPage(main, _rest, { worlds }) {
  const jobBox = h('div')
  const list = h('div')
  const load = async () => {
    const r = await get('/api/backups')
    fill(
      list,
      card(
        `In ${r.dir}`,
        table(
          [
            [
              'Backup',
              (b) => h('a', { href: `/api/backups/${encodeURIComponent(b.name)}` }, b.name),
            ],
            [
              'Size',
              (b) =>
                `${b.sizeKb >= 1024 ? `${(b.sizeKb / 1024).toFixed(1)} MB` : `${b.sizeKb} KB`}`,
            ],
            ['Made', (b) => when(b.at)],
            [
              '',
              (b) =>
                button(
                  'Delete',
                  act(
                    confirmFirst(`Delete ${b.name}?`, async () => {
                      await del(`/api/backups/${encodeURIComponent(b.name)}`)
                      await load()
                    }),
                    'Deleted.'
                  ),
                  'small danger'
                ),
            ],
          ],
          r.backups,
          { empty: 'No backups yet.' }
        )
      )
    )
  }
  const start = (url) =>
    act(async () =>
      fill(
        jobBox,
        card(
          null,
          jobView(await post(url), () => load())
        )
      )
    )
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Backups'),
        h(
          'p',
          {},
          'A court’s state (.state without its logs, and the folder both worlds share), the local server’s world, copied while the server holds its saving, or the court’s database (pg_dump; restore with pg_restore). Restoring is done by hand on the host.'
        )
      ),
      h(
        'div',
        { class: 'actions' },
        worlds.map((w) =>
          button(`Back up ${w.label}’s state`, start(`/api/worlds/${w.id}/backup`))
        ),
        button('Back up the database', start('/api/database/backup')),
        button('Back up the local server’s world', start('/api/server/backup'), 'primary')
      )
    ),
    jobBox,
    list
  )
  await load()
}

// ---- Jobs ------------------------------------------------------------------------------------

export async function jobsPage(main) {
  const view = h('div')
  const list = h('div')
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Jobs'),
        h(
          'p',
          {},
          'What the admin ran lately: rebuilds, container changes, tools and backups (kept until the admin restarts).'
        )
      )
    ),
    view,
    list
  )
  every(5_000, async () => {
    const jobs = await get('/api/jobs')
    fill(
      list,
      card(
        null,
        table(
          [
            ['Job', (j) => h('b', {}, j.title)],
            [
              'State',
              (j) =>
                badge(
                  j.status,
                  j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn'
                ),
            ],
            ['Started', (j) => ago(j.startedAt)],
            [
              'Took',
              (j) => (j.endedAt ? `${Math.round((j.endedAt - j.startedAt) / 1000)} s` : '…'),
            ],
          ],
          jobs,
          {
            empty: 'Nothing has run since the admin started.',
            onclick: async (j) => fill(view, card(null, jobView(await get(`/api/jobs/${j.id}`)))),
          }
        )
      )
    )
  })
}

// ---- The admin -------------------------------------------------------------------------------

export async function adminPage(main) {
  const info = await get('/api/admin')
  const audit = await get('/api/audit')
  const current = h('input', { type: 'password', autocomplete: 'current-password' })
  const next = h('input', { type: 'password', autocomplete: 'new-password' })
  const again = h('input', { type: 'password', autocomplete: 'new-password' })
  const change = act(async () => {
    if (next.value !== again.value) throw new Error('The new passwords differ.')
    await post('/api/password', { current: current.value, next: next.value })
    for (const el of [current, next, again]) el.value = ''
  }, 'The password is changed; everyone else is signed out.')
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Password & audit'),
        h('p', {}, 'The admin’s own settings, and everything changed through it.')
      )
    ),
    info.firstPassword
      ? h(
          'div',
          { class: 'notice bad' },
          `The password is still the one made at first start (in ${info.data}/first-password.txt on the host). Change it here.`
        )
      : null,
    h(
      'div',
      { class: 'grid wide' },
      card(
        'Change the password',
        h(
          'div',
          { class: 'form' },
          h('label', {}, 'Current'),
          h('div', { class: 'field' }, current),
          h('label', {}, 'New'),
          h(
            'div',
            { class: 'field' },
            next,
            h('div', { class: 'help' }, 'At least 10 characters.')
          ),
          h('label', {}, 'New again'),
          h('div', { class: 'field' }, again)
        ),
        h('div', { class: 'row end' }, button('Change', change, 'primary'))
      ),
      card(
        'What the admin manages',
        table(
          [
            ['World', (w) => h('b', {}, w.label)],
            ['Checkout', (w) => h('span', { class: 'mono' }, w.dir)],
            ['Shared folder', (w) => h('span', { class: 'mono' }, w.shared)],
            ['Mounted', (w) => (w.mounted ? badge('yes', 'ok') : badge('no', 'bad'))],
          ],
          info.worlds
        ),
        kv([
          [
            'Local server',
            info.server
              ? `${info.server.service} in ${info.server.dir}${info.server.mounted ? '' : ' (not mounted)'}`
              : 'none',
          ],
          ['Admin data', info.data],
          ['Backups', info.backups],
        ]),
        h(
          'p',
          { class: 'small muted' },
          'These come from the admin’s environment (compose.admin.yaml and its .env): a new world needs its folder mounted there.'
        )
      )
    ),
    card(
      'Audit log',
      table(
        [
          ['When', (a) => h('span', { class: 'nowrap' }, when(a.at))],
          ['From', (a) => h('span', { class: 'mono' }, a.ip)],
          ['What', (a) => a.action],
          [
            'Detail',
            (a) =>
              a.detail !== undefined
                ? h(
                    'span',
                    { class: 'mono small' },
                    typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail).slice(0, 200)
                  )
                : '',
          ],
        ],
        audit,
        { empty: 'Nothing yet.' }
      )
    )
  )
}
