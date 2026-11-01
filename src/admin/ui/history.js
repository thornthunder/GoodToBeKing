// The court's database: its history (Court > History) and the database itself (Services > Database).
import {
  act,
  ago,
  badge,
  button,
  card,
  every,
  fill,
  get,
  h,
  input,
  jobView,
  kv,
  post,
  select,
  stat,
  table,
  when,
} from './lib.js'

const KINDS = [
  ['', 'everything'],
  ['chat', 'talk'],
  ['notice', 'server notices'],
  ['magic', 'magic'],
  ['order', 'orders & rules'],
  ['work', 'work'],
  ['court', 'the court'],
]

const KIND_BADGE = {
  chat: '',
  notice: 'warn',
  magic: 'ok',
  order: 'bad',
  work: '',
  court: 'warn',
}

function noDatabase(main, title, s) {
  fill(
    main,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title))),
    h(
      'div',
      { class: 'notice warn' },
      s?.configured === false
        ? 'The admin has no database: set DATABASE_URL in admin.env (and in each world’s settings) and start the database (compose.db.yaml).'
        : `The database does not answer: ${s?.error ?? 'unknown trouble'}.`
    )
  )
}

/** "12:04:31" today, else the date too. */
function stamp(ms) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

function who(row) {
  const whisper = row.data?.whisper
  const actor = row.actor || ''
  const courtier = row.data?.courtier
  return h(
    'span',
    {},
    actor ? h(courtier ? 'span' : 'b', {}, actor) : null,
    row.target ? h('span', { class: 'muted' }, whisper ? ' whispers to ' : ' → ') : null,
    row.target ? h(courtier ? 'b' : 'span', {}, row.target) : null
  )
}

// ---- History ---------------------------------------------------------------------------------

export async function historyPage(main, _rest, { worlds }) {
  const status = await get('/api/database').catch((err) => ({ up: false, error: err.message }))
  if (!status.up) return noDatabase(main, 'History', status)
  const world = select([['', 'every world'], ...worlds.map((w) => [w.id, w.label])], '')
  const kind = select(KINDS, '')
  const name = input({ size: 12, placeholder: 'name' })
  const words = input({ size: 22, placeholder: 'words' })
  const live = h('input', { type: 'checkbox', checked: true })
  const info = h('span', { class: 'muted small' })
  const list = h('div')
  const more = h('div', { class: 'row' })
  let rows = []
  /** The last page came back full: there may be older lines. */
  let full = false
  const params = (extra = {}) =>
    new URLSearchParams(
      Object.entries({
        world: world.value,
        kind: kind.value,
        who: name.value,
        q: words.value,
        ...extra,
      }).filter(([, v]) => v !== '' && v !== undefined)
    )
  const show = () => {
    fill(
      list,
      table(
        [
          ['When', (r) => h('span', { class: 'mono', title: when(r.at) }, stamp(r.at))],
          ...(worlds.length > 1 && !world.value ? [['World', (r) => r.world]] : []),
          ['', (r) => badge(r.kind, KIND_BADGE[r.kind] ?? '')],
          ['Who', who],
          ['', (r) => h('span', { class: r.data?.courtier ? 'muted' : '' }, r.text)],
        ],
        rows,
        { empty: 'Nothing recorded that matches.' }
      )
    )
    fill(info, rows.length ? `${rows.length} lines shown` : '')
    fill(
      more,
      full
        ? button(
            'Older',
            act(async () => {
              const page = await get(`/api/history?${params({ before: rows[rows.length - 1].id })}`)
              full = page.length >= 200
              rows = rows.concat(page)
              show()
            })
          )
        : null
    )
  }
  const load = async () => {
    rows = await get(`/api/history?${params()}`)
    full = rows.length >= 200
    show()
  }
  for (const el of [world, kind, name, words]) el.addEventListener('change', load)
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'History'),
        h(
          'p',
          {},
          'What the court heard and did: talk where a courtier could hear it (whispers too), the server’s notices, Merlin’s spells, the royals’ orders and rules, and the court’s work. Talk is kept a week, the rest a month (each world’s Database settings). Lines that looked like a password are never written down.'
        )
      )
    ),
    card(
      null,
      h(
        'div',
        { class: 'fields' },
        h('label', {}, 'World', world),
        h('label', {}, 'What', kind),
        h('label', {}, 'Who', name),
        h('label', {}, 'Search', words),
        h('label', {}, 'Follow', live),
        info
      ),
      list,
      more
    )
  )
  await load()
  // Following: the newest lines join the top while the first page is shown.
  every(5_000, async () => {
    if (!live.checked || !rows.length) return
    const newer = await get(`/api/history?${params({ after: rows[0].id })}`)
    if (!newer.length) return
    rows = newer.concat(rows)
    show()
  })
}

// ---- Database --------------------------------------------------------------------------------

export async function databasePage(main) {
  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      h('h1', {}, 'Database'),
      h(
        'p',
        {},
        'The court’s Postgres (compose.db.yaml), on this machine only. It holds the court’s history and the admin’s audit log; the court keeps playing when it is away, and writes once it is back.'
      )
    )
  )
  const jobBox = h('div')
  const body = h('div', { class: 'stack' })
  fill(main, head, jobBox, body)
  every(15_000, async () => {
    const s = await get('/api/database')
    if (!s.configured || !s.up) {
      fill(
        body,
        h(
          'div',
          { class: 'notice bad' },
          s.configured
            ? `The database does not answer: ${s.error}.`
            : 'The admin has no database (DATABASE_URL in admin.env).'
        )
      )
      return
    }
    fill(
      body,
      h(
        'div',
        { class: 'grid' },
        card(
          'Server',
          h('div', {}, stat(s.version ?? '?', 'version'), stat(`${s.sizeMb} MB`, 'on disk')),
          kv([
            ['State', badge('answering', 'ok')],
            ['Container', s.container],
          ]),
          h(
            'div',
            { class: 'row' },
            button(
              'Back up now',
              act(async () =>
                fill(jobBox, card(null, jobView(await post('/api/database/backup'))))
              ),
              'primary'
            ),
            h('a', { href: '#/backups' }, 'All backups')
          )
        ),
        card(
          'Connected',
          table(
            [
              ['Who', (c) => c.name],
              ['State', (c) => c.state || '—'],
              ['Connections', (c) => c.count],
            ],
            s.connections,
            { empty: 'Nobody.' }
          )
        )
      ),
      card(
        'History held',
        table(
          [
            ['World', (r) => r.world || '—'],
            ['What', (r) => KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind],
            ['Lines', (r) => r.count],
            ['Oldest', (r) => ago(r.oldest)],
            ['Newest', (r) => ago(r.newest)],
          ],
          s.history,
          { empty: 'Nothing yet.' }
        )
      ),
      h(
        'div',
        { class: 'grid' },
        card(
          'Tables',
          table(
            [
              ['Table', (t) => h('span', { class: 'mono' }, t.name)],
              ['Rows (about)', (t) => t.rows],
              ['Size', (t) => `${t.sizeKb} KB`],
            ],
            s.tables
          )
        ),
        card(
          'Schema',
          table(
            [
              ['', (m) => m.id],
              ['Migration', (m) => m.what],
              ['Applied', (m) => when(m.at)],
            ],
            s.migrations
          )
        )
      )
    )
  })
}
