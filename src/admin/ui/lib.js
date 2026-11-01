// Helpers for the admin's pages. Every text goes in as text (never as HTML): names, chat and
// memories come from players.

/** An element: h('div', { class: 'card', onclick: fn }, 'text', child, [more]). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2), value)
    else if (key === 'class') el.className = value
    else if (key === 'value') el.value = value
    else if (key === 'checked') el.checked = Boolean(value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  add(el, children)
  return el
}

function add(el, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue
    if (Array.isArray(child)) add(el, child)
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** Empty an element and fill it again. */
export function fill(el, ...children) {
  el.replaceChildren()
  add(el, children)
  return el
}

// ---- Talking to the admin ------------------------------------------------------------------

export class SignedOut extends Error {}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'X-Admin': '1',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && !url.endsWith('/api/login')) {
    window.dispatchEvent(new Event('signed-out'))
    throw new SignedOut('sign in first')
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`)
  return data
}

export const get = (url) => api('GET', url)
export const post = (url, body = {}) => api('POST', url, body)
export const put = (url, body) => api('PUT', url, body)
export const del = (url, body) => api('DELETE', url, body)

export function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text)
  document.getElementById('toasts').append(el)
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500)
}

/** Run an action from a button: the button waits, the outcome is said. */
export function act(fn, done) {
  return async (event) => {
    const button = event?.currentTarget
    if (button) button.disabled = true
    try {
      const result = await fn(event)
      if (done) toast(typeof done === 'function' ? done(result) : done, 'ok')
      return result
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message, 'bad')
    } finally {
      if (button) button.disabled = false
    }
  }
}

export function confirmFirst(question, fn) {
  return (event) => (window.confirm(question) ? fn(event) : undefined)
}

// ---- Pieces of pages -----------------------------------------------------------------------

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...children)
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text)
}

/** A badge for a container's or a process's state. */
export function stateBadge(state) {
  const kind =
    {
      running: 'ok',
      spawned: 'ok',
      active: 'ok',
      exited: 'bad',
      dead: 'bad',
      failed: 'bad',
      away: '',
      stopped: '',
    }[state] ?? 'warn'
  return badge(state, kind)
}

export function button(label, onclick, kind = '') {
  return h('button', { class: kind, onclick, type: 'button' }, label)
}

/** A table: columns are [title, row => cell]. */
export function table(columns, rows, opts = {}) {
  if (!rows.length) return h('p', { class: 'muted' }, opts.empty ?? 'Nothing.')
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          columns.map(([title]) => h('th', {}, title))
        )
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            opts.onclick ? { class: 'clickable', onclick: () => opts.onclick(row) } : {},
            columns.map(([, cell]) => h('td', {}, cell(row)))
          )
        )
      )
    )
  )
}

export function kv(pairs) {
  return h(
    'dl',
    { class: 'kv' },
    pairs
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
  )
}

export function stat(value, label) {
  return h('span', { class: 'stat' }, h('b', {}, value), h('span', {}, label))
}

export function bar(value, max, kind = '') {
  const pct = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100))
  const i = h('i', { class: pct < 35 ? 'low' : '' })
  i.style.width = `${pct}%`
  return h('span', { class: `bar ${kind}`, title: `${value ?? '?'} / ${max}` }, i)
}

/** A JSON value as a tree that opens where wanted. */
export function jsonTree(value, open = 1, key) {
  const label = key !== undefined ? h('span', { class: 'k' }, `${key}: `) : null
  if (value === null || typeof value !== 'object') {
    const cls = typeof value === 'string' ? 's' : 'n'
    return h('div', { class: 'leaf' }, label, h('span', { class: cls }, JSON.stringify(value)))
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`
  return h(
    'details',
    { open: open > 0 },
    h('summary', {}, label, summary),
    entries.slice(0, 500).map(([k, v]) => jsonTree(v, open - 1, k)),
    entries.length > 500
      ? h('div', { class: 'leaf muted' }, `… ${entries.length - 500} more`)
      : null
  )
}

export function json(value, open = 2) {
  return h('div', { class: 'json' }, jsonTree(value, open))
}

// ---- Time ----------------------------------------------------------------------------------

export function ago(ms) {
  if (!ms) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 0) return `in ${until(ms)}`
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

export function until(ms) {
  const s = Math.round((ms - Date.now()) / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 360) / 10} h`
}

export function when(ms) {
  return ms ? new Date(ms).toLocaleString() : '—'
}

export function point(p) {
  return p ? `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` : '—'
}

// ---- Polling and jobs ----------------------------------------------------------------------

const timers = new Set()

/** Call fn now and every ms while this page is shown. */
export function every(ms, fn) {
  const tick = async () => {
    try {
      await fn()
    } catch (err) {
      if (!(err instanceof SignedOut)) console.warn(err)
    }
  }
  void tick()
  const id = setInterval(tick, ms)
  timers.add(id)
  return id
}

export function stopTimers() {
  for (const id of timers) clearInterval(id)
  timers.clear()
}

/** A job's output, followed until it ends (and its picture, if it drew one). */
export function jobView(job, onEnd) {
  const head = h('div', { class: 'row' })
  const out = h('pre', { class: 'out short' })
  const pic = h('div')
  const box = h('div', { class: 'stack' }, head, out, pic)
  const show = (j) => {
    fill(
      head,
      h('b', {}, j.title),
      stateBadge(j.status === 'done' ? 'done' : j.status),
      j.endedAt
        ? h('span', { class: 'muted small' }, `${Math.round((j.endedAt - j.startedAt) / 1000)} s`)
        : h('span', { class: 'muted small' }, 'under way…')
    )
    head.querySelector('.badge').className =
      `badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn'}`
    out.textContent = j.output || '…'
    out.scrollTop = out.scrollHeight
    if (j.status !== 'running' && j.file && j.status === 'done')
      fill(
        pic,
        h('img', { class: 'render', src: `/api/jobs/${j.id}/file?t=${j.endedAt}`, alt: 'picture' })
      )
  }
  show(job)
  const id = every(1500, async () => {
    const j = await get(`/api/jobs/${job.id}`)
    show(j)
    if (j.status !== 'running') {
      clearInterval(id)
      timers.delete(id)
      onEnd?.(j)
    }
  })
  return box
}

/** A log line, coloured by its level, chat lines picked out. */
export function logLine(line) {
  const level = line.slice(13, 18).trim()
  const chat = / <[^>]+> /.test(line)
  return h('span', { class: chat ? 'chat' : level }, line + '\n')
}

/** Text input helper. */
export function input(attrs = {}) {
  return h('input', { type: 'text', ...attrs })
}

export function select(options, value, attrs = {}) {
  return h(
    'select',
    attrs,
    options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o === '' ? '—' : o]
      return h('option', { value: v, selected: v === value }, label)
    })
  )
}
