// The court as a whole: its bots, the royal family, what each courtier remembers, and the orders
// and rules they keep.
import {
  act,
  ago,
  badge,
  button,
  card,
  confirmFirst,
  del,
  fill,
  get,
  h,
  input,
  kv,
  put,
  select,
  table,
  when,
} from './lib.js'

function worldPicker(worlds, value, onchange, label = 'Bots file of') {
  const sel = select(
    worlds.map((w) => [w.id, w.label]),
    value
  )
  sel.addEventListener('change', () => onchange(sel.value))
  return h('label', { class: 'row' }, h('span', { class: 'muted' }, label), sel)
}

// ---- Bots ------------------------------------------------------------------------------------

export async function botsPage(main, [worldId], { worlds }) {
  const wid = worldId ?? worlds[0]?.id
  const data = await get(`/api/court/bots?world=${wid}`)
  let bots = structuredClone(data.bots)
  let chosen = bots[0]?.name
  let dirty = false
  const list = h('div')
  const editor = h('div')
  const status = h('div')
  const mark = () => {
    dirty = true
    fill(status, h('div', { class: 'notice warn' }, 'Unsaved changes.'))
  }

  const showList = () =>
    fill(
      list,
      card(
        `The court (${bots.length} bots)`,
        table(
          [
            ['Bot', (b) => h('b', {}, b.name)],
            ['Role', (b) => b.role ?? ''],
            ['Mind', (b) => b.division ?? 'household'],
            ['Reports to', (b) => b.reportsTo ?? h('span', { class: 'muted' }, 'the royals')],
            [
              'Does',
              (b) =>
                h(
                  'div',
                  { class: 'chips' },
                  [
                    b.magic && 'magic',
                    b.everywhere && 'every world',
                    b.works && 'castle works',
                    b.canBuild && 'builds',
                    b.duty?.kind && `duty: ${b.duty.kind}`,
                  ]
                    .filter(Boolean)
                    .map((t) => h('span', { class: 'chip' }, t))
                ),
            ],
            ['', (b) => (data.edits[b.name] !== undefined ? badge('edited here', 'accent') : '')],
          ],
          bots,
          {
            onclick: (b) => {
              chosen = b.name
              showEditor()
            },
          }
        ),
        h(
          'div',
          { class: 'row' },
          button('Add a bot…', addBot),
          h('span', { class: 'spacer' }),
          button('Save the court', save, 'primary')
        )
      )
    )

  const field = (label, el, help) => [
    h('label', {}, label),
    h('div', { class: 'field' }, el, help ? h('div', { class: 'help' }, help) : null),
  ]

  const showEditor = () => {
    const b = bots.find((x) => x.name === chosen)
    if (!b) return fill(editor)
    const json = h('textarea', { class: 'code' }, JSON.stringify(b, null, 2))
    const refreshJson = () => (json.value = JSON.stringify(b, null, 2))
    const bind = (el, get, set) => {
      el.addEventListener('change', () => {
        set(el.type === 'checkbox' ? el.checked : el.value)
        refreshJson()
        mark()
        showList()
      })
      if (el.type === 'checkbox') el.checked = Boolean(get())
      else el.value = get() ?? ''
      return el
    }
    const setKey = (obj, key, v) => {
      if (v === '' || v === false || v === undefined) delete obj[key]
      else obj[key] = v
    }
    const check = () => h('input', { type: 'checkbox' })
    const names = bots.map((x) => x.name).filter((n) => n !== b.name)
    const duty = b.duty ?? {}
    fill(
      editor,
      card(
        h('span', {}, `Edit ${b.name}`),
        h(
          'div',
          { class: 'form' },
          field(
            'Role',
            bind(
              input(),
              () => b.role,
              (v) => setKey(b, 'role', v)
            ),
            'The bot’s place at court, in its prompt.'
          ),
          field(
            'Mind',
            bind(
              select(['household', 'army'], b.division ?? 'household'),
              () => b.division ?? 'household',
              (v) => setKey(b, 'division', v === 'household' ? '' : v)
            ),
            'Which process runs it: the household (food, building, repairs) or the army (security).'
          ),
          field(
            'Reports to',
            bind(
              select(['', ...names]),
              () => b.reportsTo,
              (v) => setKey(b, 'reportsTo', v)
            ),
            'Empty: answers to the royal family alone.'
          ),
          field(
            'Persona',
            bind(
              h('textarea'),
              () => b.persona,
              (v) => setKey(b, 'persona', v)
            ),
            'How it talks and behaves. The court’s safety rules (the Princess is a child) are fixed in code and always come first.'
          ),
          field(
            'Builds',
            bind(
              check(),
              () => b.canBuild,
              (v) => setKey(b, 'canBuild', v)
            ),
            'Builds from the spellbook and hall work.'
          ),
          field(
            'Castle works',
            bind(
              check(),
              () => b.works,
              (v) => setKey(b, 'works', v)
            ),
            'Part of the building crew.'
          ),
          field(
            'Magic',
            bind(
              check(),
              () => b.magic,
              (v) => setKey(b, 'magic', v)
            ),
            'Works Merlin’s magic (needs operator rights on the server).'
          ),
          field(
            'In every world',
            bind(
              check(),
              () => b.everywhere,
              (v) => setKey(b, 'everywhere', v)
            ),
            'Like Merlin: in both worlds at once.'
          ),
          field(
            'Remembers',
            bind(
              select([
                ['', 'everything it hears'],
                ['own', 'only talk it took part in'],
              ]),
              () => b.remembers,
              (v) => setKey(b, 'remembers', v)
            )
          ),
          field(
            'View distance',
            bind(
              input({ inputmode: 'numeric', placeholder: '12' }),
              () => b.viewDistance,
              (v) => setKey(b, 'viewDistance', v === '' ? '' : Number(v))
            ),
            'Chunks it asks for around it; fewer for guards near home.'
          ),
          field(
            'Duty',
            bind(
              select([
                ['', 'none'],
                ['escort', 'escort a royal (when asked)'],
              ]),
              () => duty.kind,
              (v) => {
                if (v)
                  b.duty = {
                    kind: v,
                    royals: duty.royals ?? ['Princess', 'King'],
                    ...(duty.auto ? { auto: true } : {}),
                  }
                else delete b.duty
                showEditor()
              }
            )
          ),
          b.duty
            ? field(
                'Royals to escort',
                bind(
                  input(),
                  () => (b.duty.royals ?? []).join(', '),
                  (v) =>
                    (b.duty.royals = v
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean))
                ),
                'Titles in order of preference, e.g. Princess, King.'
              )
            : null,
          field(
            'Greeting',
            bind(
              input(),
              () => b.chat?.greeting,
              (v) => {
                b.chat = { ...b.chat }
                setKey(b.chat, 'greeting', v)
                if (!Object.keys(b.chat).length) delete b.chat
              }
            )
          ),
          field(
            'Thinking lines',
            bind(
              h('textarea'),
              () => (b.chat?.thinking ?? []).join('\n'),
              (v) => {
                const lines = v
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean)
                b.chat = { ...b.chat }
                setKey(b.chat, 'thinking', lines.length ? lines : '')
                if (!Object.keys(b.chat).length) delete b.chat
              }
            ),
            'Said while a royal’s answer is still coming, one per line.'
          ),
          field(
            'Skin',
            bind(
              input({ placeholder: 'config/skins/name.png' }),
              () => b.skin?.texture,
              (v) => {
                if (v) b.skin = { ...b.skin, texture: v }
                else delete b.skin
              }
            ),
            'The court’s skins are in config/skins.'
          )
        ),
        h('h3', {}, 'Everything (JSON)'),
        json,
        h(
          'div',
          { class: 'row' },
          button('Use this JSON', () => {
            try {
              const parsed = JSON.parse(json.value)
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.name)
                throw new Error('a bot is an object with a name')
              bots = bots.map((x) => (x.name === b.name ? parsed : x))
              chosen = parsed.name
              mark()
              showList()
              showEditor()
            } catch (err) {
              window.alert(err.message)
            }
          }),
          h('span', { class: 'spacer' }),
          button(
            `Remove ${b.name} from the court`,
            () => {
              if (!window.confirm(`Remove ${b.name} from the court? Its memories stay on disk.`))
                return
              bots = bots.filter((x) => x.name !== b.name)
              chosen = bots[0]?.name
              mark()
              showList()
              showEditor()
            },
            'danger'
          )
        )
      )
    )
  }

  function addBot() {
    const name = window.prompt('The new bot’s player name (letters, digits, underscores):')
    if (!name) return
    if (bots.some((b) => b.name.toLowerCase() === name.toLowerCase()))
      return window.alert('There is a bot of that name.')
    const like =
      window.prompt(
        `Start from a copy of which bot? (${bots.map((b) => b.name).join(', ')}; empty: from scratch)`
      ) ?? ''
    const model = bots.find((b) => b.name.toLowerCase() === like.toLowerCase())
    const copy = model
      ? structuredClone(model)
      : { role: 'courtier', canBuild: false, works: false }
    delete copy.skin
    delete copy.magic
    delete copy.everywhere
    bots.push({ ...copy, name })
    chosen = name
    mark()
    showList()
    showEditor()
  }

  const save = act(async () => {
    const r = await put('/api/court/bots', { world: wid, bots })
    data.edits = r.edits
    dirty = false
    fill(
      status,
      h(
        'div',
        { class: 'notice' },
        'Saved. Each world’s court starts with these bots next time it starts: restart the courts (Containers & deploy) to apply.'
      )
    )
    showList()
    return r
  }, 'The court is saved.')

  const dropEdits = act(
    confirmFirst(
      'Forget every change made here, so the bots are exactly as in the bots file in git?',
      async () => {
        await del(`/api/court/bots/edits?world=${wid}`)
        location.reload()
      }
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
        h('h1', {}, 'Bots'),
        h(
          'p',
          {},
          `The court’s bots for every world: ${data.botsFile} with the changes made here (${data.editsFile}).`
        )
      ),
      h(
        'div',
        { class: 'actions' },
        worldPicker(worlds, wid, (id) => (location.hash = `#/bots/${id}`)),
        button('Drop all changes made here', dropEdits, 'danger')
      )
    ),
    data.problems.length ? h('div', { class: 'notice bad' }, data.problems.join(' ')) : null,
    status,
    h('div', { class: 'grid wide' }, list, editor)
  )
  showList()
  showEditor()
  window.onbeforeunload = () => (dirty ? true : undefined)
}

// ---- The royal family ------------------------------------------------------------------------

export async function rosterPage(main, [worldId], { worlds }) {
  const wid = worldId ?? worlds[0]?.id
  const data = await get(`/api/court/roster?world=${wid}`)
  const roster = structuredClone(data.roster)
  const realm = input({ value: roster.realm, size: 30 })
  const charter = h('textarea', {}, roster.charter ?? '')
  const rows = h('div')
  const targets = worlds.map((w) => [w, h('input', { type: 'checkbox', checked: true })])
  const showRows = () =>
    fill(
      rows,
      roster.members.map((m, i) => {
        const f = (key, attrs = {}) => {
          const el =
            key === 'notes'
              ? h(
                  'textarea',
                  { placeholder: 'Guidance for the bots about this person' },
                  m[key] ?? ''
                )
              : input({ value: m[key] ?? '', ...attrs })
          el.addEventListener('change', () => (m[key] = el.value))
          return el
        }
        return card(
          h(
            'span',
            {},
            m.title || 'New member',
            ' ',
            h('span', { class: 'muted small' }, m.player)
          ),
          h(
            'div',
            { class: 'fields' },
            h('label', {}, 'Player name', f('player', { size: 18 })),
            h('label', {}, 'Role', f('role', { size: 10, placeholder: 'king' })),
            h('label', {}, 'Title', f('title', { size: 10, placeholder: 'King' })),
            h('label', {}, 'Address', f('address', { size: 16, placeholder: 'Your Majesty' }))
          ),
          h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'Notes'), f('notes')),
          h(
            'div',
            { class: 'row end' },
            button(
              'Remove',
              () => {
                if (window.confirm(`Remove ${m.player} from the royal family?`)) {
                  roster.members.splice(i, 1)
                  showRows()
                }
              },
              'danger small'
            )
          )
        )
      })
    )
  showRows()
  const save = act(
    async () => {
      roster.realm = realm.value
      roster.charter = charter.value
      const chosen = targets.filter(([, c]) => c.checked).map(([w]) => w.id)
      if (!chosen.length) throw new Error('Choose a world to save to.')
      return put('/api/court/roster', { worlds: chosen, roster })
    },
    (r) =>
      `Saved to ${r.worlds.join(' and ')}. The court reads the roster when it starts: restart it to apply.`
  )
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Royal family'),
        h(
          'p',
          {},
          `Who the court serves (${data.file}). Rank comes from the role: king, then queen, prince and princess.`
        )
      ),
      h(
        'div',
        { class: 'actions' },
        worldPicker(worlds, wid, (id) => (location.hash = `#/roster/${id}`), 'Roster of')
      )
    ),
    h(
      'div',
      { class: 'stack' },
      card(
        'The realm',
        h(
          'div',
          { class: 'form' },
          h('label', {}, 'Name'),
          h('div', { class: 'field' }, realm),
          h('label', {}, 'Charter'),
          h(
            'div',
            { class: 'field' },
            charter,
            h(
              'div',
              { class: 'help' },
              'What the court is for and how every bot behaves towards the royal family.'
            )
          )
        )
      ),
      rows,
      h(
        'div',
        { class: 'row' },
        button('Add a member', () => {
          roster.members.push({ player: '', role: '', title: '', address: '' })
          showRows()
        }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted' }, 'Save to:'),
        targets.map(([w, c]) => h('label', { class: 'row' }, c, w.label)),
        button('Save', save, 'primary')
      )
    )
  )
}

// ---- Memories --------------------------------------------------------------------------------

export async function memoryPage(main, [bot], { worlds }) {
  const wid = worlds[0]?.id
  const counts = await get(`/api/court/memory?world=${wid}`)
  const chosen = bot ?? counts.find((c) => c.facts)?.bot ?? counts[0]?.bot
  const body = h('div')
  fill(
    main,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Memories'),
        h(
          'p',
          {},
          'What each courtier remembers, by whom or what it is about. Private facts (real life) only reach a prompt while nobody but the royal family is online; secrets are never told.'
        )
      )
    ),
    h(
      'div',
      { class: 'tabs' },
      counts.map((c) =>
        h(
          'a',
          { href: `#/memory/${c.bot}`, class: c.bot === chosen ? 'active' : '' },
          `${c.bot} (${c.facts})`
        )
      )
    ),
    body
  )
  if (!chosen) return
  const facts = await get(`/api/court/memory/${chosen}?world=${wid}`)
  const q = input({ size: 30, placeholder: 'search' })
  const list = h('div', { class: 'stack' })
  const show = () => {
    const needle = q.value.toLowerCase()
    fill(
      list,
      Object.entries(facts)
        .map(([subject, fs]) => [
          subject,
          fs.filter(
            (f) => !needle || f.text.toLowerCase().includes(needle) || subject.includes(needle)
          ),
        ])
        .filter(([, fs]) => fs.length)
        .map(([subject, fs]) =>
          card(
            `About ${subject} (${fs.length})`,
            table(
              [
                ['Fact', (f) => f.text],
                [
                  '',
                  (f) =>
                    h(
                      'span',
                      { class: 'chips' },
                      f.private ? badge('private', 'warn') : null,
                      f.secret ? badge('secret', 'bad') : null
                    ),
                ],
                ['When', (f) => h('span', { class: 'nowrap small muted' }, when(f.at))],
                [
                  '',
                  (f) =>
                    button(
                      'Forget',
                      act(
                        confirmFirst(`Make ${chosen} forget: “${f.text}”?`, async () => {
                          await del(`/api/court/memory/${chosen}?world=${wid}`, {
                            subject,
                            at: f.at,
                            text: f.text,
                          })
                          fs.splice(fs.indexOf(f), 1)
                          facts[subject] = fs
                          show()
                        }),
                        'Forgotten.'
                      ),
                      'danger small'
                    ),
                ],
              ],
              [...fs].reverse()
            )
          )
        )
    )
  }
  q.addEventListener('input', show)
  fill(body, h('div', { class: 'stack' }, h('div', { class: 'row' }, q), list))
  show()
}

// ---- Orders and rules ------------------------------------------------------------------------

export async function ordersPage(main, _rest, { worlds }) {
  const wid = worlds[0]?.id
  const load = async () => {
    const data = await get(`/api/court/orders?world=${wid}`)
    const withOrders = data.bots.filter((b) => b.orders?.length || b.reports?.length)
    fill(
      main,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h1', {}, 'Orders & rules'),
          h(
            'p',
            {},
            'Standing orders royals gave each courtier, the reports they owe, and the rules for the whole court. The courts see a change within a few seconds.'
          )
        )
      ),
      h(
        'div',
        { class: 'stack' },
        card(
          'Rules for the whole court',
          table(
            [
              ['#', (r) => r.id],
              ['Rule', (r) => r.text],
              ['By', (r) => r.by ?? r.from],
              ['Since', (r) => ago(r.at)],
              [
                '',
                (r) =>
                  button(
                    'Take away',
                    act(
                      confirmFirst(`Take away the rule “${r.text}”?`, async () => {
                        await del(`/api/court/rules/${r.id}?world=${wid}`)
                        await load()
                      }),
                      'The rule is gone.'
                    ),
                    'danger small'
                  ),
              ],
            ],
            data.rules.rules ?? [],
            { empty: 'No rules.' }
          )
        ),
        withOrders.length
          ? withOrders.map((b) =>
              card(
                b.bot,
                table(
                  [
                    ['#', (o) => o.id],
                    ['Order', (o) => o.text],
                    ['By', (o) => o.by ?? o.from],
                    [
                      'Keeps it busy',
                      (o) =>
                        o.post ? `${o.post.type}${o.post.target ? ` ${o.post.target}` : ''}` : '',
                    ],
                    ['Since', (o) => ago(o.at)],
                    [
                      '',
                      (o) =>
                        button(
                          'Release',
                          act(
                            confirmFirst(`Release ${b.bot} from “${o.text}”?`, async () => {
                              await del(`/api/court/orders/${b.bot}/${o.id}?world=${wid}`)
                              await load()
                            }),
                            'Released.'
                          ),
                          'small'
                        ),
                    ],
                  ],
                  b.orders ?? [],
                  { empty: 'No standing orders.' }
                ),
                b.reports?.length ? kv([['Reports owed', b.reports.join(' · ')]]) : null
              )
            )
          : card('Standing orders', h('p', { class: 'muted' }, 'No courtier has standing orders.'))
      )
    )
  }
  await load()
}
