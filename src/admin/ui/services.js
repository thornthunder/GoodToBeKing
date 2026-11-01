// What the court connects to: the game servers (and the one on this machine), and Ollama.
import {
  act,
  badge,
  button,
  card,
  confirmFirst,
  every,
  fill,
  get,
  h,
  input,
  jobView,
  kv,
  post,
  put,
  select,
  stat,
  table,
  until,
  when,
} from './lib.js'
import { settingsForm } from './world.js'

// ---- Game servers ----------------------------------------------------------------------------

export async function serversPage(main, _rest, { worlds }) {
  const local = await get('/api/server').catch(() => undefined)
  const conn = h('div', { class: 'grid wide' })
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Game servers'),
        h('p', {}, 'Where each world’s court plays, and the Bedrock server on this machine.')
      )
    ),
    h(
      'div',
      { class: 'stack' },
      conn,
      local
        ? localServer(local)
        : card(
            'Local server',
            h('p', { class: 'muted' }, 'No local server is set up for the admin (ADMIN_SERVER).')
          )
    )
  )
  for (const w of worlds) {
    const s = await get(`/api/worlds/${w.id}/settings`)
    const sections = s.sections.filter((x) => x.id === 'server')
    const { form, changes } = settingsForm(sections, s.values)
    const box = h('div')
    const save = act(async () => {
      const c = changes()
      if (!Object.keys(c).length) throw new Error('Nothing changed.')
      await put(`/api/worlds/${w.id}/settings`, { changes: c })
      fill(
        box,
        h(
          'div',
          { class: 'notice warn row' },
          'Saved. The court joins the new server once its containers are made again.',
          h('span', { class: 'spacer' }),
          button(
            'Apply now',
            act(
              async () => fill(box, jobView(await post(`/api/worlds/${w.id}/apply`))),
              'Applying…'
            ),
            'primary'
          )
        )
      )
      return c
    }, 'Saved.')
    conn.append(
      h(
        'div',
        { class: 'stack' },
        h('h2', {}, w.label),
        box,
        form,
        h('div', { class: 'row end' }, button('Save', save, 'primary'))
      )
    )
  }
}

/** A line of the server's console, its warnings and errors coloured. */
const consoleLine = (line) =>
  h(
    'span',
    { class: / ERROR\]/.test(line) ? 'ERROR' : / WARN\]/.test(line) ? 'WARN' : '' },
    line + '\n'
  )

function localServer(s) {
  const head = h('div')
  const out = h('pre', { class: 'log' })
  const cmd = input({ size: 50, placeholder: 'a console command, e.g. list' })
  const jobBox = h('div')
  let size = 0
  const showHead = (x) =>
    fill(
      head,
      kv([
        ['State', x.running ? badge('running', 'ok') : badge('not running', 'bad')],
        [
          'systemd',
          x.control
            ? `${x.control.activeState ?? '?'} (${x.control.subState ?? '?'})${x.control.since ? ` since ${x.control.since}` : ''}, checked ${when(x.control.at)}`
            : 'not asked yet',
        ],
        ['Version', x.version],
        ['Players', x.players.length ? x.players.join(', ') : 'nobody'],
        ['Folder', x.def.dir],
        ['Court', x.def.world ? `the ${x.def.world} world plays here` : undefined],
      ])
    )
  showHead(s)
  const control = (action) =>
    act(
      confirmFirst(
        `${action[0].toUpperCase()}${action.slice(1)} the server? Everyone on it is disconnected (the court reconnects by itself).`,
        async () => {
          const r = await post('/api/server/control', { action })
          showHead(await get('/api/server'))
          return r
        }
      ),
      (r) => `The server is ${r.activeState ?? 'asked'} (${r.subState ?? ''}).`
    )
  const send = act(async () => {
    await post('/api/server/console', { command: cmd.value })
    cmd.value = ''
  })
  cmd.addEventListener('keydown', (e) => e.key === 'Enter' && send(e))
  const quick = [
    'list',
    'time query daytime',
    'weather query',
    'gamerule',
    'difficulty',
    'save query',
  ].map((c) =>
    button(
      c,
      act(() => post('/api/server/console', { command: c })),
      'small'
    )
  )
  const props = propertiesCard(s.properties)
  every(2_000, async () => {
    const r = await get(`/api/server/console${size ? `?from=${size}` : ''}`)
    const first = size === 0
    size = r.size
    const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 30
    const lines = r.text.split('\n').filter(Boolean).map(consoleLine)
    if (first) fill(out, lines.slice(-400))
    else out.append(...lines)
    if (first || atEnd) out.scrollTop = out.scrollHeight
  })
  every(15_000, async () => showHead(await get('/api/server')))
  return h(
    'div',
    { class: 'stack' },
    h('h2', {}, s.def.label ?? 'Local server'),
    h(
      'div',
      { class: 'grid wide' },
      card(
        'State',
        head,
        h(
          'div',
          { class: 'row' },
          button('Start', control('start')),
          button('Restart', control('restart')),
          button('Stop', control('stop'), 'danger'),
          button(
            'Ask systemd',
            act(async () => {
              await post('/api/server/control', { action: 'status' })
              showHead(await get('/api/server'))
            })
          ),
          h('span', { class: 'spacer' }),
          button(
            'Back up the world',
            act(async () => fill(jobBox, jobView(await post('/api/server/backup'))), 'Backing up…')
          )
        ),
        jobBox
      ),
      props
    ),
    card(
      'Console',
      h(
        'div',
        { class: 'sub' },
        'Typed straight into the server’s console, as its operator. Answers show below.'
      ),
      h('div', { class: 'row' }, cmd, button('Send', send, 'primary')),
      h('div', { class: 'row' }, quick),
      out
    )
  )
}

function propertiesCard(properties) {
  const inputs = {}
  const common = [
    'gamemode',
    'difficulty',
    'allow-cheats',
    'online-mode',
    'max-players',
    'level-name',
    'view-distance',
    'tick-distance',
    'player-idle-timeout',
    'default-player-permission-level',
    'server-port',
    'allow-list',
  ]
  const row = (p) => {
    const el = input({ value: p.value, size: 24 })
    inputs[p.key] = [el, p.value]
    return [
      h('label', { class: 'mono' }, p.key),
      h(
        'div',
        { class: 'field' },
        el,
        p.help ? h('div', { class: 'help' }, p.help.slice(0, 300)) : null
      ),
    ]
  }
  const first = properties.filter((p) => common.includes(p.key))
  const rest = properties.filter((p) => !common.includes(p.key))
  const save = act(async () => {
    const changes = Object.fromEntries(
      Object.entries(inputs)
        .filter(([, [el, was]]) => el.value !== was)
        .map(([k, [el]]) => [k, el.value])
    )
    if (!Object.keys(changes).length) throw new Error('Nothing changed.')
    await put('/api/server/properties', { changes })
    for (const [k, v] of Object.entries(changes)) inputs[k][1] = v
    return changes
  }, 'Saved: the server reads server.properties when it starts, so restart it.')
  return card(
    'server.properties',
    h('div', { class: 'form' }, first.flatMap(row)),
    h(
      'details',
      {},
      h('summary', { class: 'muted' }, `All ${properties.length} settings`),
      h('div', { class: 'form' }, rest.flatMap(row))
    ),
    h('div', { class: 'row end' }, button('Save', save, 'primary'))
  )
}

// ---- Ollama ----------------------------------------------------------------------------------

export async function ollamaPage(main) {
  const data = await get('/api/ollama')
  const services = data.services.map((s) => ({ ...s }))
  const servicesBox = h('div')
  const showServices = () =>
    fill(
      servicesBox,
      card(
        'Model servers the admin knows',
        h(
          'div',
          { class: 'stack' },
          services.map((s, i) => {
            const name = input({ value: s.name, size: 14 })
            const url = input({ value: s.url, size: 34 })
            name.addEventListener('change', () => (s.name = name.value))
            url.addEventListener('change', () => (s.url = url.value))
            return h(
              'div',
              { class: 'row' },
              name,
              url,
              button(
                'Remove',
                () => {
                  services.splice(i, 1)
                  showServices()
                },
                'small danger'
              )
            )
          }),
          h(
            'div',
            { class: 'row' },
            button('Add a server', () => {
              services.push({ name: 'New', url: 'http://host:11434' })
              showServices()
            }),
            h('span', { class: 'spacer' }),
            button(
              'Save',
              act(() => put('/api/ollama/services', { services }), 'Saved.'),
              'primary'
            )
          )
        )
      )
    )
  showServices()
  const nameOf = (url) => services.find((s) => s.url.replace(/\/$/, '') === url)?.name ?? url
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Ollama'),
        h('p', {}, 'The model servers, what they hold, and which models each world’s court uses.')
      )
    ),
    h(
      'div',
      { class: 'notice warn' },
      'The court shares its model server (and gemma4:31b) with another program. Nothing here loads, pulls or unloads a model; a model asked for with another context is loaded again, so the court asks for shared models as they are loaded.'
    ),
    h(
      'div',
      { class: 'stack' },
      servicesBox,
      h(
        'div',
        { class: 'grid wide' },
        data.infos.map((info) => serviceCard(info, nameOf(info.url)))
      ),
      h(
        'div',
        { class: 'grid wide' },
        data.worlds.map((w) => assignCard(w, data.infos, services))
      ),
      testCard(data.infos)
    )
  )
}

function serviceCard(info, name) {
  return card(
    h('span', {}, name, ' ', info.ok ? badge(`up, ${info.ms} ms`, 'ok') : badge('down', 'bad')),
    h('div', { class: 'sub' }, info.url),
    info.ok ? null : h('div', { class: 'notice bad' }, info.error),
    info.ok
      ? h(
          'div',
          {},
          stat(info.version, 'version'),
          stat(info.models.length, 'models'),
          stat(`${info.loaded.reduce((n, m) => n + m.vramGb, 0).toFixed(1)} GB`, 'in VRAM'),
          h('h3', {}, 'Loaded now'),
          table(
            [
              ['Model', (m) => h('b', {}, m.name)],
              ['VRAM', (m) => `${m.vramGb} / ${m.sizeGb} GB`],
              ['Context', (m) => m.context ?? '—'],
              ['Stays', (m) => (m.expiresAt ? until(Date.parse(m.expiresAt)) : '—')],
            ],
            info.loaded,
            { empty: 'Nothing loaded.' }
          ),
          h(
            'details',
            {},
            h('summary', { class: 'muted' }, `All ${info.models.length} models`),
            table(
              [
                ['Model', (m) => m.name],
                ['Size', (m) => `${m.sizeGb} GB`],
                ['Parameters', (m) => m.parameters ?? ''],
                ['Quantization', (m) => m.quantization ?? ''],
              ],
              info.models
            )
          )
        )
      : null
  )
}

function assignCard(w, infos, services) {
  const urls = [
    ...new Set([...services.map((s) => s.url), ...infos.map((i) => i.url), w.host].filter(Boolean)),
  ]
  const host = select(
    urls.map((u) => [
      u,
      services.find((s) => s.url === u)?.name
        ? `${services.find((s) => s.url === u).name} (${u})`
        : u,
    ]),
    w.host
  )
  const roles = [
    ['OLLAMA_MODEL', 'Chat'],
    ['OLLAMA_ORDER_MODEL', 'Orders (reads royal lines)'],
    ['OLLAMA_MEMORY_MODEL', 'Memory'],
    ['OVERLORD_MODEL', 'Overlord (castle designs)'],
  ]
  const pickers = {}
  const models = () =>
    infos.find((i) => i.url === host.value.replace(/\/$/, ''))?.models.map((m) => m.name) ?? []
  const box = h('div', { class: 'form' })
  const showPickers = () =>
    fill(
      box,
      roles.flatMap(([key, label]) => {
        const list = [...new Set(['', ...models(), w.models[key]].filter((x) => x !== undefined))]
        const el = select(
          list.map((m) => [m, m === '' ? '— the chat model —' : m]),
          pickers[key]?.value ?? w.models[key]
        )
        pickers[key] = el
        return [
          h('label', {}, label),
          h('div', { class: 'field' }, el, h('div', { class: 'help mono' }, key)),
        ]
      })
    )
  host.addEventListener('change', showPickers)
  showPickers()
  const apply = h('div')
  const save = act(async () => {
    const changes = { OLLAMA_HOST: host.value }
    for (const [key] of roles) changes[key] = pickers[key].value
    await put(`/api/worlds/${w.id}/settings`, { changes })
    fill(
      apply,
      h(
        'div',
        { class: 'notice warn row' },
        'Saved. The court uses them once its containers are made again.',
        h('span', { class: 'spacer' }),
        button(
          'Apply now',
          act(async () => fill(apply, jobView(await post(`/api/worlds/${w.id}/apply`)))),
          'primary'
        )
      )
    )
  }, 'Saved.')
  return card(
    `${w.label} uses`,
    h('div', { class: 'form' }, h('label', {}, 'Server'), h('div', { class: 'field' }, host)),
    box,
    apply,
    h('div', { class: 'row end' }, button('Save', save, 'primary'))
  )
}

function testCard(infos) {
  const up = infos.filter((i) => i.ok)
  const server = select(
    up.map((i) => i.url),
    up[0]?.url
  )
  const model = h('select')
  const prompt = h(
    'textarea',
    {},
    'Say hello to the King in one short sentence, as a court wizard would.'
  )
  const out = h('div')
  const showModels = () => {
    const info = up.find((i) => i.url === server.value)
    const loaded = new Set(info?.loaded.map((m) => m.name))
    fill(
      model,
      (info?.models ?? []).map((m) =>
        h(
          'option',
          { value: m.name, selected: loaded.has(m.name) && !model.value },
          `${m.name}${loaded.has(m.name) ? ' (loaded)' : ''}`
        )
      )
    )
  }
  server.addEventListener('change', showModels)
  showModels()
  const ask = act(async () => {
    const info = up.find((i) => i.url === server.value)
    if (
      !info?.loaded.some((m) => m.name === model.value) &&
      !window.confirm(
        `${model.value} is not loaded: asking it loads it on ${server.value}, which may push another model out. Ask anyway?`
      )
    )
      return
    fill(out, h('p', { class: 'muted' }, 'Asking…'))
    const r = await post('/api/ollama/test', {
      url: server.value,
      model: model.value,
      prompt: prompt.value,
    })
    fill(
      out,
      h('pre', { class: 'out short' }, r.answer),
      h(
        'p',
        { class: 'small muted' },
        `${(r.ms / 1000).toFixed(1)} s, ${r.promptTokens ?? '?'} tokens in, ${r.outputTokens ?? '?'} out`
      )
    )
  })
  return card(
    'Test chat',
    h(
      'div',
      { class: 'sub' },
      'One question, asked as the court asks a shared model: with the context it is loaded with, never cutting its stay short.'
    ),
    h('div', { class: 'fields' }, h('label', {}, 'Server', server), h('label', {}, 'Model', model)),
    prompt,
    h('div', { class: 'row end' }, button('Ask', ask, 'primary')),
    out
  )
}
