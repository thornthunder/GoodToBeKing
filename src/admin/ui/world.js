// One world's court: who is online and what they do, commands, household, works, magic, army,
// logs, settings and the state files.
import {
  act,
  ago,
  badge,
  bar,
  button,
  card,
  confirmFirst,
  every,
  fill,
  get,
  h,
  input,
  jobView,
  json,
  kv,
  logLine,
  point,
  post,
  put,
  select,
  stat,
  stateBadge,
  table,
  until,
  when,
} from './lib.js'

const TABS = [
  ['court', 'Court'],
  ['commands', 'Commands'],
  ['household', 'Household'],
  ['works', 'Works'],
  ['magic', 'Magic'],
  ['army', 'Army'],
  ['logs', 'Logs'],
  ['settings', 'Settings'],
  ['state', 'State files'],
]

export async function worldPage(main, [id, tab = 'court', ...rest], { worlds }) {
  const w = worlds.find((x) => x.id === id)
  if (!w) return fill(main, h('div', { class: 'notice bad' }, `No world ${id}.`))
  const body = h('div')
  fill(
    main,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, w.label), h('p', {}, w.dir))),
    h(
      'div',
      { class: 'tabs' },
      TABS.map(([t, label]) =>
        h('a', { href: `#/world/${id}/${t}`, class: t === tab ? 'active' : '' }, label)
      )
    ),
    body
  )
  const page =
    {
      court: courtTab,
      commands: commandsTab,
      household: householdTab,
      works: worksTab,
      magic: magicTab,
      army: armyTab,
      logs: logsTab,
      settings: settingsTab,
      state: stateTab,
    }[tab] ?? courtTab
  await page(body, w, rest, worlds)
}

const state = (w, name) =>
  get(`/api/worlds/${w.id}/state/${encodeURIComponent(name)}`).catch(() => undefined)

// ---- Court -----------------------------------------------------------------------------------

function gear(g) {
  if (!g) return '—'
  const parts = ['head', 'chest', 'legs', 'feet'].map((k) => g[k]).filter(Boolean)
  return [
    g.sword
      ? /sword|axe/.test(g.sword)
        ? g.sword.replace(/_/g, ' ')
        : `${g.sword} sword`
      : 'no sword',
    parts.length ? `${[...new Set(parts)].join('/')} armour (${parts.length}/4)` : 'no armour',
    g.shield ? 'shield' : '',
  ]
    .filter(Boolean)
    .join(', ')
}

async function courtTab(body, w, _rest, worlds) {
  every(5_000, async () => {
    const s = await get(`/api/worlds/${w.id}/status`)
    const bots = s.status.flatMap((m) => m.bots.map((b) => ({ ...b, stale: m.stale })))
    const players = [
      ...new Map(s.status.flatMap((m) => m.players).map((p) => [p.name, p])).values(),
    ]
    const household = s.status.find((m) => m.division !== 'army')
    fill(
      body,
      h(
        'div',
        { class: 'stack' },
        courtWhere(s, w, worlds),
        card(
          'Courtiers',
          table(
            [
              ['Bot', (b) => h('b', {}, b.name)],
              ['Role', (b) => h('span', { class: 'muted' }, b.role)],
              ['Mind', (b) => b.division],
              ['State', (b) => (b.stale ? badge('silent', 'bad') : stateBadge(b.status))],
              [
                'Doing',
                (b) =>
                  b.doing ? b.doing : b.free ? h('span', { class: 'muted' }, 'free') : 'busy',
              ],
              ['Health', (b) => (b.health !== undefined ? bar(b.health, 20) : '—')],
              ['Food', (b) => (b.food !== undefined ? bar(b.food, 20, 'food') : '—')],
              ['Where', (b) => h('span', { class: 'mono nowrap' }, point(b.position))],
              ['Gear', (b) => h('span', { class: 'small' }, gear(b.gear))],
              ['Orders', (b) => b.post ?? ''],
              [
                'Wakes at',
                (b) =>
                  b.spawnPoint === null
                    ? badge('world spawn', 'warn')
                    : b.spawnPoint
                      ? h('span', { class: 'mono small' }, point(b.spawnPoint))
                      : '—',
              ],
              ['', (b) => h('a', { href: `#/world/${w.id}/commands/${b.name}` }, 'command…')],
            ],
            bots,
            { empty: 'No status from the court yet.' }
          )
        ),
        h(
          'div',
          { class: 'grid' },
          card(
            'Players online',
            table(
              [
                ['Player', (p) => p.name],
                ['Title', (p) => p.title ?? ''],
                ['Where', (p) => h('span', { class: 'mono' }, point(p.position))],
              ],
              players,
              { empty: 'Nobody.' }
            )
          ),
          household
            ? card(
                'Housekeeping',
                kv([
                  ['Home', point(household.home)],
                  [
                    'Under way',
                    household.underway.length
                      ? h(
                          'div',
                          { class: 'chips' },
                          household.underway.map((k) => h('span', { class: 'chip' }, k))
                        )
                      : 'nothing',
                  ],
                  [
                    'Resting',
                    household.resting.length
                      ? h(
                          'div',
                          { class: 'chips' },
                          household.resting.map((k) => h('span', { class: 'chip' }, k))
                        )
                      : 'nothing',
                  ],
                  [
                    'Merlin’s magic left',
                    household.magicLeft !== undefined
                      ? `${household.magicLeft} this hour`
                      : undefined,
                  ],
                ])
              )
            : null,
          card(
            'Processes',
            table(
              [
                ['Mind', (m) => m.division],
                ['Written', (m) => (m.stale ? badge(ago(m.at), 'bad') : ago(m.at))],
                ['Up since', (m) => ago(m.process.startedAt)],
                ['Memory', (m) => `${m.process.rssMb} MB`],
                ['Lag', (m) => `${m.process.lagMs} ms`],
              ],
              s.status
            ),
            h(
              'div',
              { class: 'row' },
              (Array.isArray(s.containers) ? s.containers : []).map((c) =>
                h('span', {}, `${c.name} `, stateBadge(c.state))
              )
            ),
            s.version
              ? h('p', { class: 'small muted' }, `Code: ${s.version.commit} ${s.version.subject}`)
              : null
          )
        )
      )
    )
  })
}

function courtWhere(s, w, worlds) {
  const p = s.presence
  if (!p) return null
  const here = s.courtWorldHere
  const others = worlds.filter((x) => x.id !== w.id)
  return h(
    'div',
    { class: 'notice row' },
    h(
      'span',
      {},
      `The court is in the ${p.world} world${p.by ? ` (called by ${p.by} ${ago(p.at)})` : ''}.`
    ),
    h('span', { class: 'spacer' }),
    here && here !== p.world
      ? button(
          `Bring the court to the ${here} world`,
          act(
            confirmFirst(
              `Move the court (all but Merlin) to the ${here} world? Its bots leave the ${p.world} world.`,
              () => post(`/api/worlds/${w.id}/presence`, { world: here })
            ),
            'The court is on its way.'
          )
        )
      : others.length
        ? h(
            'span',
            { class: 'small muted' },
            'The court follows the King; you can move it from the other world’s page.'
          )
        : null
  )
}

// ---- Commands --------------------------------------------------------------------------------

async function commandsTab(body, w, [preset]) {
  const c = await get(`/api/worlds/${w.id}/commands`)
  const targets = [
    ...c.bots.map((b) => [b.name, `${b.name} (${b.role ?? b.division ?? 'household'})`]),
    ['', '— the court as a whole —'],
  ]
  const who = select(targets, preset ?? c.bots[0]?.name ?? '')
  const verbSel = h('select')
  const fields = h('div', { class: 'fields' })
  const help = h('p', { class: 'muted small' })
  const preview = h('code', { class: 'mono' })
  const follow = h('pre', { class: 'log hidden' })
  let inputs = {}

  const bot = () => c.bots.find((b) => b.name === who.value)
  const verbs = () =>
    c.verbs.filter((v) =>
      who.value === ''
        ? v.who === 'household' || v.who === 'works'
        : v.who === 'bot' || (v.who === 'magic' && bot()?.magic)
    )
  const verb = () => c.verbs.find((v) => v.verb === verbSel.value)

  const fieldInput = (f) => {
    const options = f.options ?? (f.source ? c[f.source] : undefined)
    if (f.kind === 'select') return select(f.optional ? ['', ...options] : options, '')
    if (f.kind === 'int')
      return input({
        class: 'num',
        inputmode: 'numeric',
        placeholder: f.optional ? 'optional' : '',
      })
    if (f.kind === 'point') return input({ placeholder: 'x y z', size: 14 })
    if (f.kind === 'text') return input({ size: 50 })
    return input({ placeholder: f.optional ? 'optional' : '', size: f.kind === 'place' ? 22 : 16 })
  }
  const spec = () => ({
    bot: who.value || undefined,
    verb: verbSel.value,
    args: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])),
  })
  // The line as the admin will write it (or what is still wrong), from the admin itself.
  let previewTimer
  const showPreview = () => {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(async () => {
      const r = await post(`/api/worlds/${w.id}/commands/preview`, { spec: spec() }).catch(
        (err) => ({ error: err.message })
      )
      preview.textContent = r.line ?? `(${r.error})`
      preview.className = r.line ? 'mono' : 'mono muted'
    }, 200)
  }
  const showVerb = () => {
    const v = verb()
    inputs = {}
    fill(
      fields,
      (v?.fields ?? []).map((f) => {
        const el = fieldInput(f)
        el.addEventListener('input', showPreview)
        el.addEventListener('change', showPreview)
        inputs[f.name] = el
        return h('label', { title: f.help ?? '' }, f.label + (f.optional ? '' : ' *'), el)
      })
    )
    fill(help, v?.help ?? '')
    showPreview()
  }
  const showVerbs = () => {
    const list = verbs()
    const groups = [...new Set(list.map((v) => v.group))]
    fill(
      verbSel,
      groups.map((g) =>
        h(
          'optgroup',
          { label: g },
          list.filter((v) => v.group === g).map((v) => h('option', { value: v.verb }, v.label))
        )
      )
    )
    showVerb()
  }
  who.addEventListener('change', showVerbs)
  verbSel.addEventListener('change', showVerb)
  showVerbs()

  const followLog = (sent) => {
    follow.classList.remove('hidden')
    fill(follow, h('span', { class: 'DEBUG' }, `sent: ${sent.line}\n`))
    let from = sent.from
    let n = 0
    const id = setInterval(async () => {
      if (++n > 30 || !document.body.contains(follow)) return clearInterval(id)
      const r = await get(
        `/api/worlds/${w.id}/logs/follow?division=${sent.division}&day=${sent.day}&from=${from}`
      ).catch(() => undefined)
      if (!r) return
      from = r.size
      for (const line of r.text.split('\n').filter(Boolean)) follow.append(logLine(line))
      follow.scrollTop = follow.scrollHeight
    }, 1000)
  }
  const send = act(
    async () => {
      const sent = await post(`/api/worlds/${w.id}/commands`, { spec: spec() })
      followLog(sent)
      return sent
    },
    (r) => `Sent to the ${r.division}: ${r.line}`
  )

  const raw = input({ size: 60, placeholder: 'e.g. Henry fetch wood 16' })
  const sendRaw = act(
    async () => {
      const sent = await post(`/api/worlds/${w.id}/commands`, { line: raw.value })
      followLog(sent)
      return sent
    },
    (r) => `Sent to the ${r.division}: ${r.line}`
  )

  fill(
    body,
    h(
      'div',
      { class: 'stack' },
      card(
        'Give a command',
        h(
          'div',
          { class: 'sub' },
          'Written to the world’s command file; the court picks it up within a second. Soldiers’ commands go to the army’s mind.'
        ),
        h('div', { class: 'fields' }, h('label', {}, 'Who', who), h('label', {}, 'What', verbSel)),
        help,
        fields,
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted small' }, 'Line: '),
          preview,
          h('span', { class: 'spacer' }),
          button('Send', send, 'primary')
        )
      ),
      card(
        'Type a line',
        h(
          'div',
          { class: 'sub' },
          'Any line the court understands (see CLAUDE.md, “Commands to a running app”).'
        ),
        h('div', { class: 'row' }, raw, button('Send', sendRaw))
      ),
      card(
        'What the court said',
        follow,
        h(
          'p',
          { class: 'muted small' },
          'After a command, its mind’s log is followed here for half a minute.'
        )
      )
    )
  )
}

// ---- Household -------------------------------------------------------------------------------

async function householdTab(body, w) {
  const hh = await state(w, 'household.json')
  const estate = await state(w, 'estate.json')
  if (!hh)
    return fill(
      body,
      h('p', { class: 'muted' }, 'No household yet: a royal has not declared a home in this world.')
    )
  const items = Object.entries(hh.stock?.items ?? {}).sort((a, b) => b[1] - a[1])
  fill(
    body,
    h(
      'div',
      { class: 'grid wide' },
      card(
        'Home',
        kv([
          [
            'Home',
            hh.home
              ? `${point(hh.home)}${hh.home.setBy ? ` (declared by ${hh.home.setBy})` : ''}`
              : 'none',
          ],
          ['Storehouse', hh.storehouse ? point(hh.storehouse) : 'none'],
          ['Old storehouse', hh.formerStore ? point(hh.formerStore) : undefined],
          [
            'Hall',
            hh.hall
              ? `floor at ${hh.hall.floorY}, walls up to ${hh.hall.wallTop}, ${hh.hall.inside?.length ?? 0} squares inside`
              : 'not surveyed',
          ],
          ['Estate', hh.estateWords ?? (estate?.words || undefined)],
        ]),
        h(
          'p',
          { class: 'small muted' },
          'Declare another home or storehouse on the Commands tab (“the court as a whole”).'
        )
      ),
      card(
        `Storehouse (${items.reduce((n, [, c]) => n + c, 0)} items, seen ${ago(hh.stockAt ?? hh.stock?.at)})`,
        items.length
          ? h(
              'div',
              { class: 'chips' },
              items.map(([k, v]) =>
                h('span', { class: 'chip' }, k.replace(/_/g, ' '), h('b', {}, v))
              )
            )
          : h('p', { class: 'muted' }, 'Empty.')
      ),
      card(
        'Grounds',
        kv([
          [
            'Field',
            hh.farm
              ? `${hh.farm.cells?.length ?? 0} squares at y ${hh.farm.y}${hh.farm.watered ? ', watered' : ', dry'}`
              : 'none yet',
          ],
          [
            'Grove',
            hh.grove
              ? `${hh.grove.spots?.length ?? hh.grove.trees?.length ?? 0} trees`
              : 'none yet',
          ],
          [
            'Mine',
            hh.mine ? `at ${point(hh.mine.entrance ?? hh.mine.start ?? hh.mine)}` : 'none yet',
          ],
          ['Fishing', hh.fishing ? `stand at ${hh.fishing.stand?.join(' ')}` : 'no water known'],
        ]),
        h('h3', {}, 'All of it'),
        json({ farm: hh.farm, grove: hh.grove, mine: hh.mine, fishing: hh.fishing }, 1)
      ),
      estate
        ? card(
            'Estate',
            h('p', {}, estate.words ?? ''),
            kv([
              ['Found', when(estate.foundAt)],
              ['Last looked', when(estate.at)],
              ['Blocks kept as made', Object.keys(estate.made ?? {}).length],
              ['Waiting to settle', Object.keys(estate.pending ?? {}).length],
            ])
          )
        : null
    )
  )
}

// ---- Works -----------------------------------------------------------------------------------

async function worksTab(body, w) {
  const cw = await state(w, 'court-works.json')
  const files = await get(`/api/worlds/${w.id}/state`)
  const plans = await Promise.all(
    files.world.filter((f) => /^works-.+\.json$/.test(f.name)).map((f) => state(w, f.name))
  )
  const commissions = await state(w, 'commissions.json')
  const works = (verb) =>
    act(() => post(`/api/worlds/${w.id}/commands`, { spec: { verb } }), 'Sent to the household.')
  fill(
    body,
    h(
      'div',
      { class: 'stack' },
      card(
        'Castle works',
        kv([
          ['Current design', cw?.current],
          ['Built', cw?.built?.join(', ')],
          ['Ordered by a royal', cw?.ordered ? JSON.stringify(cw.ordered) : undefined],
        ]),
        h(
          'div',
          { class: 'row' },
          button('Status to the log', works('status')),
          button('Pause', works('pause')),
          button('Resume', works('resume-works')),
          button(
            'Overlord: plan the next castle',
            confirmFirst(
              'Have the overlord design the next castle now (minutes of the big model)?',
              works('plan')
            )
          )
        )
      ),
      plans.filter(Boolean).map((p) => {
        const sections = Object.entries(p.sections ?? {})
        const by = (s) => sections.filter(([, x]) => x.status === s).length
        return card(
          `Plan: ${p.plan}`,
          h(
            'div',
            {},
            stat(`${by('done')} / ${sections.length}`, 'sections done'),
            stat(by('incomplete') + by('failed'), 'incomplete or failed'),
            stat(
              p.finishedAt ? 'finished' : p.paused ? 'paused' : 'under way',
              when(p.finishedAt ?? p.startedAt)
            )
          ),
          table(
            [
              ['Section', ([id]) => id],
              ['Status', ([, s]) => stateBadge(s.status ?? '?')],
              ['By', ([, s]) => s.worker ?? ''],
              ['Tries', ([, s]) => s.attempts ?? ''],
            ],
            sections
          )
        )
      }),
      card(
        'Commissions',
        table(
          [
            ['#', (c) => c.id],
            ['Build', (c) => c.title ?? c.blueprint],
            ['For', (c) => c.requestedBy],
            ['Builder', (c) => c.worker ?? c.takenBy ?? ''],
            ['Status', (c) => stateBadge(c.status)],
            ['Tries', (c) => c.attempts ?? 0],
            ['When', (c) => ago(c.at)],
          ],
          [...(commissions?.commissions ?? [])].reverse(),
          { empty: 'No royal has asked for a build.' }
        )
      )
    )
  )
}

// ---- Magic -----------------------------------------------------------------------------------

async function magicTab(body, w) {
  const m = await state(w, 'magic-merlin.json')
  const blessing = await state(w, 'blessing.json')
  const merlin = async (verb) =>
    post(`/api/worlds/${w.id}/commands`, { spec: { bot: 'Merlin', verb } })
  const hour = (m?.given ?? []).filter((g) => Date.now() - g.at < 3_600_000)
  fill(
    body,
    h(
      'div',
      { class: 'grid wide' },
      card(
        'This hour',
        stat(
          hour.reduce((n, g) => n + (g.items ?? 1), 0),
          'magic used in the last hour (at most 10)'
        ),
        h(
          'p',
          { class: 'small muted' },
          'Each casting counts one and each thing conjured counts one; travel is free. The army’s blessing is outside the ten.'
        ),
        h(
          'div',
          { class: 'row' },
          button(
            'List spells and places in the log',
            act(() => merlin('spells'), 'Merlin lists them in the log.')
          ),
          button(
            'Take every gift back now',
            act(
              confirmFirst('Take back every gift that has not faded yet?', () => merlin('fade')),
              'The gifts fade.'
            ),
            'danger'
          ),
          h('a', { class: 'button', href: `#/world/${w.id}/commands/Merlin` }, 'Cast a spell…')
        )
      ),
      card(
        'Gifts still to fade',
        table(
          [
            ['To', (g) => g.to ?? g.target ?? g.player ?? ''],
            ['What', (g) => g.item ?? g.what ?? JSON.stringify(g).slice(0, 60)],
            ['Given', (g) => ago(g.at)],
            ['Fades', (g) => (g.at ? until(g.at + 86_400_000) : '')],
          ],
          m?.gifts ?? [],
          { empty: 'None.' }
        )
      ),
      card(
        'Spells the King taught',
        table(
          [
            ['Spell', (s) => h('b', {}, s.name ?? s.id)],
            ['Does', (s) => s.does ?? ''],
          ],
          m?.learned ?? [],
          { empty: 'Only the built-in spells.' }
        )
      ),
      card(
        'The army’s blessing',
        blessing
          ? kv([
              ['Last', when(blessing.at)],
              ['Asked by', blessing.by],
            ])
          : h('p', { class: 'muted' }, 'Never given in this world.')
      )
    )
  )
}

// ---- Army ------------------------------------------------------------------------------------

async function armyTab(body, w) {
  const army = await state(w, 'army.json')
  const stock = await state(w, 'army-stock.json')
  const portals = await state(w, 'army-portals.json')
  const mine = await state(w, 'army-mine.json')
  const soldiers = Object.entries(army?.soldiers ?? {})
  fill(
    body,
    h(
      'div',
      { class: 'grid wide' },
      card(
        `Soldiers under ${army?.leader ?? 'Sarge'} (reported ${ago(army?.at)})`,
        table(
          [
            ['Soldier', ([n]) => h('b', {}, n)],
            ['Gear', ([, g]) => gear(g)],
          ],
          soldiers,
          { empty: 'No report yet.' }
        ),
        h(
          'p',
          { class: 'small muted' },
          'Patrols, hunting and the army’s mine are given out by its own mind; send a soldier a command on the Commands tab.'
        )
      ),
      card(
        'Storehouse as soldiers saw it',
        stock?.items
          ? h(
              'div',
              { class: 'chips' },
              Object.entries(stock.items)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => h('span', { class: 'chip' }, k.replace(/_/g, ' '), h('b', {}, v)))
            )
          : h('p', { class: 'muted' }, 'Nothing seen yet.'),
        stock?.at ? h('p', { class: 'small muted' }, ago(stock.at)) : null
      ),
      card(
        'Portal asks',
        portals && Object.keys(portals).length
          ? json(portals)
          : h('p', { class: 'muted' }, 'No soldier is waiting for Merlin.')
      ),
      card('The army’s mine', mine ? json(mine, 1) : h('p', { class: 'muted' }, 'None yet.'))
    )
  )
}

// ---- Logs ------------------------------------------------------------------------------------

async function logsTab(body, w) {
  const minds = w.divisions
  const mind = select(minds, minds[0])
  const day = h('select')
  const level = select(
    [
      ['', 'all levels'],
      ['INFO', 'info'],
      ['WARN', 'warnings'],
      ['ERROR', 'errors'],
      ['DEBUG', 'debug'],
    ],
    ''
  )
  const bot = input({ size: 10, placeholder: 'bot' })
  const q = input({ size: 22, placeholder: 'search' })
  const live = h('input', { type: 'checkbox', checked: true })
  const info = h('span', { class: 'muted small' })
  const out = h('pre', { class: 'log' })
  let size = 0
  let shownDay = ''
  const load = async (keepDay) => {
    const params = new URLSearchParams({
      division: mind.value,
      level: level.value,
      bot: bot.value,
      q: q.value,
      limit: '800',
    })
    if (keepDay && day.value) params.set('day', day.value)
    const r = await get(`/api/worlds/${w.id}/logs?${params}`)
    if (!keepDay || !day.options.length)
      fill(
        day,
        r.days.map((d) => h('option', { value: d, selected: d === r.day }, d))
      )
    shownDay = r.day
    size = r.size
    fill(
      info,
      r.matched > r.lines.length
        ? `the last ${r.lines.length} of ${r.matched} lines`
        : `${r.lines.length} lines`
    )
    fill(out, r.lines.map(logLine))
    out.scrollTop = out.scrollHeight
  }
  const filtered = () => level.value || bot.value || q.value
  for (const el of [mind]) el.addEventListener('change', () => load(false))
  for (const el of [day, level]) el.addEventListener('change', () => load(true))
  for (const el of [bot, q]) el.addEventListener('change', () => load(true))
  fill(
    body,
    card(
      null,
      h(
        'div',
        { class: 'fields' },
        h('label', {}, 'Mind', mind),
        h('label', {}, 'Day (UTC)', day),
        h('label', {}, 'Level', level),
        h('label', {}, 'Bot', bot),
        h('label', {}, 'Search', q),
        h('label', {}, 'Follow', live),
        info
      ),
      h('div', { class: 'row' }),
      out
    )
  )
  await load(false)
  every(3_000, async () => {
    if (!live.checked || filtered() || shownDay !== day.options[0]?.value) return
    const r = await get(
      `/api/worlds/${w.id}/logs/follow?division=${mind.value}&day=${shownDay}&from=${size}`
    )
    size = r.size
    const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 30
    for (const line of r.text.split('\n').filter(Boolean)) out.append(logLine(line))
    while (out.childNodes.length > 3000) out.firstChild.remove()
    if (atEnd) out.scrollTop = out.scrollHeight
  })
}

// ---- Settings --------------------------------------------------------------------------------

export function settingInput(s, value, isSet = false) {
  const placeholder = s.default ? `default: ${s.default}` : ''
  if (s.managed) return input({ value, readonly: true, placeholder: 'set by the container' })
  // A secret is never shown: typing one replaces it, leaving it empty keeps it.
  if (s.type === 'secret')
    return input({
      type: 'password',
      value: '',
      autocomplete: 'new-password',
      placeholder: isSet ? 'set (hidden): type to replace it' : 'not set',
    })
  if (s.type === 'select')
    return select(
      s.options.map((o) => [
        o,
        o === '' ? `— ${s.default ? `default (${s.default})` : 'not set'} —` : o,
      ]),
      value
    )
  if (s.type === 'bool')
    return select(
      [
        ['', `— default (${s.default ?? 'false'}) —`],
        ['true', 'true'],
        ['false', 'false'],
      ],
      value
    )
  if (s.type === 'long') return h('textarea', { placeholder }, value)
  return input({ value, placeholder })
}

/** A form of settings; returns the element and a function giving what changed. */
export function settingsForm(sections, values, secretsSet = []) {
  const inputs = {}
  const form = h(
    'div',
    { class: 'stack' },
    sections.map((sec) =>
      card(
        sec.title,
        h('div', { class: 'sub' }, sec.help),
        h(
          'div',
          { class: 'form' },
          sec.settings.flatMap((s) => {
            const el = settingInput(s, values[s.key] ?? '', secretsSet.includes(s.key))
            inputs[s.key] = el
            const field = h(
              'div',
              { class: 'field' },
              el,
              h('div', { class: 'help' }, h('span', { class: 'mono' }, s.key), ' · ', s.help)
            )
            el.addEventListener('input', () =>
              field.classList.toggle('changed', el.value !== (values[s.key] ?? ''))
            )
            el.addEventListener('change', () =>
              field.classList.toggle('changed', el.value !== (values[s.key] ?? ''))
            )
            return [h('label', {}, s.label), field]
          })
        )
      )
    )
  )
  const changes = () => {
    const out = {}
    for (const [k, el] of Object.entries(inputs)) {
      if (el.readOnly) continue
      const before = values[k] ?? ''
      if (el.value !== before) out[k] = el.value === '' && values[k] === undefined ? null : el.value
    }
    return out
  }
  return { form, changes }
}

async function settingsTab(body, w) {
  const s = await get(`/api/worlds/${w.id}/settings`)
  const { form, changes } = settingsForm(s.sections, s.values, s.secretsSet)
  const applyBox = h('div')
  const save = act(
    async () => {
      const c = changes()
      if (!Object.keys(c).length) throw new Error('Nothing changed.')
      await put(`/api/worlds/${w.id}/settings`, { changes: c })
      fill(
        applyBox,
        h(
          'div',
          { class: 'notice warn row' },
          h(
            'span',
            {},
            'Saved to .env. The court reads it when its containers are made again: its bots reconnect.'
          ),
          h('span', { class: 'spacer' }),
          button(
            'Apply now',
            act(
              async () => fill(applyBox, jobView(await post(`/api/worlds/${w.id}/apply`))),
              'Applying…'
            ),
            'primary'
          )
        )
      )
      return c
    },
    (c) => `Saved: ${Object.keys(c).join(', ')}`
  )
  fill(
    body,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted' }, `${w.dir}/.env`),
        h('span', { class: 'spacer' }),
        button('Save changes', save, 'primary')
      ),
      applyBox,
      form,
      s.other.length
        ? card('Other settings in .env', kv(s.other.map((k) => [k, s.values[k]])))
        : null,
      h('div', { class: 'row end' }, button('Save changes', save, 'primary'))
    )
  )
}

// ---- State files -----------------------------------------------------------------------------

async function stateTab(body, w) {
  const files = await get(`/api/worlds/${w.id}/state`)
  const view = h('div')
  const open = (name) =>
    act(async () => {
      const data = await get(`/api/worlds/${w.id}/state/${encodeURIComponent(name)}`)
      fill(view, card(name, json(data, 2)))
      view.scrollIntoView({ behavior: 'smooth' })
    })
  const list = (title, rows, prefix = '') =>
    card(
      title,
      table(
        [
          [
            'File',
            (f) =>
              h(
                'a',
                {
                  href: '#',
                  onclick: (e) => {
                    e.preventDefault()
                    void open(prefix + f.name)(e)
                  },
                },
                f.name
              ),
          ],
          ['Size', (f) => `${f.sizeKb} KB`],
          ['Changed', (f) => ago(f.at)],
        ],
        rows
      )
    )
  fill(
    body,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'grid wide' },
        list('This world’s .state', files.world),
        list('Shared by both worlds', files.shared, 'shared:'),
        files.designs.length ? list('Designs', files.designs) : null
      ),
      view
    )
  )
}
