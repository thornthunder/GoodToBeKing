/**
 * Every setting a world's court reads from its .env, grouped for the admin's forms, with what it
 * does. A setting the container sets itself (compose.yaml) is `managed`: shown, not edited.
 * src/admin/settings.test.ts checks that every setting the court reads is here.
 */
export type SettingType =
  | 'text'
  | 'number'
  | 'bool'
  | 'select'
  | 'model'
  | 'point'
  | 'long'
  /** Never sent to the page: it shows only whether one is set. */
  | 'secret'

export interface Setting {
  key: string
  label: string
  help: string
  type: SettingType
  options?: string[]
  /** What the court uses when the setting is empty. */
  default?: string
  /** Set by the container (compose.yaml), not by .env. */
  managed?: boolean
}

export interface SettingSection {
  id: string
  title: string
  help: string
  settings: Setting[]
}

export const SECTIONS: SettingSection[] = [
  {
    id: 'server',
    title: 'Game server',
    help: 'The Bedrock server this world’s court joins.',
    settings: [
      {
        key: 'MC_HOST',
        label: 'Host',
        type: 'text',
        default: '127.0.0.1',
        help: 'Address of the Bedrock server (127.0.0.1: the server on this machine).',
      },
      {
        key: 'MC_PORT',
        label: 'Port',
        type: 'number',
        default: '19132',
        help: 'The server’s game port.',
      },
      {
        key: 'MC_TRANSPORT',
        label: 'Transport',
        type: 'select',
        options: ['', 'raknet', 'nethernet'],
        default: 'raknet',
        help: 'Bedrock 1.26.60 servers answer only on nethernet (WebRTC, HTTP signalling on the game port).',
      },
      {
        key: 'MC_WEBRTC',
        label: 'WebRTC backend',
        type: 'select',
        options: ['', 'wrtc', 'werift', 'auto'],
        default: 'werift',
        help: 'wrtc (native) keeps the court’s one thread free; werift (pure JS) encrypts every packet on it.',
      },
      {
        key: 'MC_OFFLINE',
        label: 'Offline login',
        type: 'bool',
        default: 'true',
        help: 'No Microsoft login: the server must run with online-mode=false.',
      },
      {
        key: 'MC_VERSION',
        label: 'Bedrock version',
        type: 'text',
        help: 'Empty: as the server says. The court’s bots always ask for 1.26.51.',
      },
      {
        key: 'MC_RAKNET_BACKEND',
        label: 'RakNet backend',
        type: 'select',
        options: ['', 'raknet-native', 'jsp-raknet'],
        help: 'Empty for real servers (jsp-raknet speaks only RakNet 10).',
      },
      {
        key: 'MC_PROFILES_FOLDER',
        label: 'Login cache folder',
        type: 'text',
        default: '.auth-cache',
        help: 'Where Microsoft tokens are kept when not offline.',
      },
      {
        key: 'IGNORE_PLAYERS',
        label: 'Players to ignore',
        type: 'text',
        default: 'Surveyor',
        help: 'Comma-separated: the court does not hear or hail these (the tools join as Surveyor).',
      },
    ],
  },
  {
    id: 'ollama',
    title: 'Ollama',
    help: 'The model server and the models for each kind of thinking. The court loads only two models; the big one is shared with another program.',
    settings: [
      {
        key: 'OLLAMA_HOST',
        label: 'Ollama server',
        type: 'text',
        default: 'http://ava:11434',
        help: 'URL of the Ollama server.',
      },
      {
        key: 'OLLAMA_MODEL',
        label: 'Chat model',
        type: 'model',
        default: 'gemma4:e4b',
        help: 'Every bot’s talk.',
      },
      {
        key: 'OLLAMA_ORDER_MODEL',
        label: 'Order model',
        type: 'model',
        help: 'Reads royal lines for orders, rules and spells before a bot answers. Empty: the chat model.',
      },
      {
        key: 'OLLAMA_MEMORY_MODEL',
        label: 'Memory model',
        type: 'model',
        help: 'Writes down what each courtier remembers. Empty: the chat model.',
      },
      {
        key: 'OVERLORD_MODEL',
        label: 'Overlord model',
        type: 'model',
        default: 'gemma4:31b',
        help: 'Designs the court’s castles.',
      },
      {
        key: 'OLLAMA_KEEP_ALIVE',
        label: 'Keep loaded',
        type: 'text',
        default: '24h',
        help: 'How long Ollama keeps the chat model loaded between requests.',
      },
      {
        key: 'OLLAMA_TEMPERATURE',
        label: 'Temperature',
        type: 'number',
        default: '0.7',
        help: 'Higher: livelier, less predictable talk.',
      },
      {
        key: 'OLLAMA_TIMEOUT_MS',
        label: 'Timeout (ms)',
        type: 'number',
        default: '60000',
        help: 'A request is given up after this long.',
      },
      {
        key: 'OLLAMA_THINK',
        label: 'Thinking',
        type: 'select',
        options: ['', 'true', 'false'],
        help: 'Empty: off on models that think (much quicker answers).',
      },
      {
        key: 'OLLAMA_NUM_CTX',
        label: 'Context window',
        type: 'number',
        help: 'Empty: the model’s own. Another context makes the server load a model again.',
      },
    ],
  },
  {
    id: 'court',
    title: 'Court',
    help: 'Who the court is and where it lives.',
    settings: [
      {
        key: 'COURT_WORLD',
        label: 'This world',
        type: 'text',
        help: 'This court’s world, e.g. dev or creative. Empty: one world, every bot in it.',
      },
      {
        key: 'COURT_HOME_WORLD',
        label: 'Home world',
        type: 'text',
        default: 'dev',
        help: 'Where the court lives when the King has not called it away.',
      },
      {
        key: 'COURT_SHARED',
        label: 'Shared folder (host)',
        type: 'text',
        help: 'The folder both worlds share on the host: memories, orders, rules, where the court is.',
      },
      {
        key: 'COURT_FILE',
        label: 'Royal roster file',
        type: 'text',
        default: 'config/court.json',
        help: 'The royal family (git-ignored).',
      },
      {
        key: 'BOTS_FILE',
        label: 'Bots file',
        type: 'text',
        help: 'The court’s bots (config/bots.json). The admin’s changes go into bots.edits.json in the shared folder.',
      },
      {
        key: 'BOTS_EDITS',
        label: 'Bot edits file',
        type: 'text',
        help: 'Where the admin’s changes to the bots are kept. Empty: bots.edits.json in the shared folder.',
      },
      {
        key: 'BOT_RESPOND_TO_ROYALS',
        label: 'Answer royals unasked',
        type: 'bool',
        default: 'true',
        help: 'Answer every royal line, even without a bot’s name in it.',
      },
      {
        key: 'BOT_GREET_VISITORS',
        label: 'Greet visitors',
        type: 'bool',
        default: 'true',
        help: 'Welcome players who are not royals. Royals are always hailed.',
      },
    ],
  },
  {
    id: 'building',
    title: 'Building',
    help: 'The court’s own building works.',
    settings: [
      {
        key: 'BUILD_CENTER',
        label: 'Build centre',
        type: 'point',
        help: '"x,y,z": the court’s own choices stay near it when no royal has chosen a home.',
      },
      {
        key: 'BUILD_RADIUS',
        label: 'Build radius',
        type: 'number',
        default: '100',
        help: 'How far from the home (or the build centre) the court builds of its own accord.',
      },
      {
        key: 'WORKS_DESIGN',
        label: 'Castle design',
        type: 'text',
        help: 'The castle the crew builds, e.g. config/castles/great-castle.json. Empty: none.',
      },
      {
        key: 'WORKS_NEXT',
        label: 'After the castle',
        type: 'select',
        options: ['', 'overlord'],
        help: 'overlord: the overlord designs and starts the next castle.',
      },
      {
        key: 'BOT_WORKS',
        label: 'Bots build by default',
        type: 'bool',
        default: 'false',
        help: 'For bots that do not say whether they join the building crew.',
      },
    ],
  },
  {
    id: 'defaults',
    title: 'Bot defaults',
    help: 'What every bot has unless the bots file says otherwise.',
    settings: [
      {
        key: 'BOT_NAME',
        label: 'Name (single bot)',
        type: 'text',
        default: 'Merlin',
        help: 'Used only without a bots file.',
      },
      {
        key: 'BOT_ROLE',
        label: 'Role',
        type: 'text',
        default: 'court wizard',
        help: 'The bot’s place at court.',
      },
      {
        key: 'BOT_PERSONA',
        label: 'Persona',
        type: 'long',
        help: 'How the bot behaves in chat. Empty: Merlin’s.',
      },
      {
        key: 'BOT_GREETING',
        label: 'Greeting',
        type: 'text',
        help: 'Said once after spawning. Empty: nothing.',
      },
      {
        key: 'BOT_CAN_BUILD',
        label: 'Can build',
        type: 'bool',
        default: 'true',
        help: 'Builds from the spellbook (others send royals to a builder).',
      },
      {
        key: 'BOT_RESPOND_TO_ALL',
        label: 'Answer every line',
        type: 'bool',
        default: 'false',
        help: 'React to every chat line, not only when named or whispered to.',
      },
      {
        key: 'BOT_CHAT_COOLDOWN_MS',
        label: 'Gap between replies (ms)',
        type: 'number',
        default: '3000',
        help: 'The least time between two replies.',
      },
      {
        key: 'BOT_HISTORY_SIZE',
        label: 'Chat lines remembered',
        type: 'number',
        default: '20',
        help: 'How much of the talk goes into each prompt.',
      },
      {
        key: 'BOT_AUTO_RECONNECT',
        label: 'Reconnect',
        type: 'bool',
        default: 'true',
        help: 'Join again with backoff when the connection drops.',
      },
      {
        key: 'BOT_SKIN',
        label: 'Skin',
        type: 'text',
        help: 'A 64x64 skin PNG. Empty: the default skin.',
      },
      {
        key: 'BOT_SKIN_GEOMETRY',
        label: 'Skin geometry',
        type: 'text',
        help: 'Custom geometry JSON for the skin.',
      },
      { key: 'BOT_CAPE', label: 'Cape', type: 'text', help: 'A 64x32 cape PNG.' },
    ],
  },
  {
    id: 'database',
    title: 'Database',
    help: 'The court’s Postgres (compose.db.yaml): the history of what the court heard and did.',
    settings: [
      {
        key: 'DATABASE_URL',
        label: 'Database',
        type: 'secret',
        help: 'postgres://user:password@127.0.0.1:5432/court. Empty: no database, no history.',
      },
      {
        key: 'HISTORY_CHAT_DAYS',
        label: 'Keep talk',
        type: 'number',
        default: '183',
        help: 'Days the history keeps what was said and the server’s notices (six months).',
      },
      {
        key: 'HISTORY_DAYS',
        label: 'Keep the rest',
        type: 'number',
        default: '183',
        help: 'Days the history keeps spells, orders, work and the court’s own events (six months).',
      },
    ],
  },
  {
    id: 'process',
    title: 'Process',
    help: 'How the court’s processes run. Most are set by the container.',
    settings: [
      {
        key: 'LOG_LEVEL',
        label: 'Log level',
        type: 'select',
        options: ['', 'debug', 'info', 'warn', 'error'],
        default: 'info',
        help: 'How much the court writes to its log.',
      },
      {
        key: 'LOG_DIR',
        label: 'Log folder',
        type: 'text',
        default: '.state/logs',
        managed: true,
        help: 'A log file a day, kept a week (the army’s: .state/logs/army).',
      },
      {
        key: 'COURT_DIVISION',
        label: 'Mind',
        type: 'text',
        managed: true,
        help: 'household or army: which bots this process runs.',
      },
      {
        key: 'COMMAND_FILE',
        label: 'Command file',
        type: 'text',
        managed: true,
        help: 'Where commands to the running court are dropped.',
      },
      {
        key: 'STOP_FILE',
        label: 'Stop file',
        type: 'text',
        default: '.stop',
        managed: true,
        help: 'Created to stop the process cleanly.',
      },
      {
        key: 'SHARED_STATE_DIR',
        label: 'Shared folder (container)',
        type: 'text',
        managed: true,
        help: 'The shared folder as the container sees it.',
      },
    ],
  },
  {
    id: 'war',
    title: 'The war game',
    help: 'Two courts, Blue and Green, raid each other’s chests on the war server (compose.war.yaml); the referee runs the season. Not settings of the family’s courts.',
    settings: [
      {
        key: 'COURT_SIDE',
        label: 'Side',
        type: 'text',
        managed: true,
        help: 'blue or green: this process is one side of the war game.',
      },
      {
        key: 'WAR_ENEMY_FILE',
        label: 'Enemy bots file',
        type: 'text',
        help: 'The other side’s bots file; empty: config/war/<other side>.json.',
      },
      {
        key: 'OLLAMA_WAR_MODEL',
        label: 'War model',
        type: 'text',
        default: 'gemma4:31b',
        help: 'Draws each side’s lessons and writes the series report (the referee).',
      },
      {
        key: 'WAR_DIR',
        label: 'War folder',
        type: 'text',
        managed: true,
        help: 'The referee’s folder, with a state folder per side.',
      },
      {
        key: 'WAR_SERVER_DIR',
        label: 'War server folder',
        type: 'text',
        managed: true,
        help: 'The war server’s folder (its console.in).',
      },
      {
        key: 'WAR_ARENA',
        label: 'Arena file',
        type: 'text',
        default: 'config/war/arena.json',
        help: 'The bases and the season’s shape.',
      },
      {
        key: 'WAR_CYCLE_MS',
        label: 'A day (ms)',
        type: 'number',
        help: 'One Minecraft day in real time; empty: the arena file’s (20 minutes).',
      },
      {
        key: 'WAR_BUILD_CYCLES',
        label: 'Days of peace',
        type: 'number',
        help: 'Before the raid; empty: the arena file’s (10).',
      },
      {
        key: 'WAR_RAID_CYCLES',
        label: 'Days of raid',
        type: 'number',
        help: 'The raid lasts this long at most; empty: the arena file’s (2).',
      },
      {
        key: 'WAR_ROUNDS',
        label: 'Rounds a series',
        type: 'number',
        help: 'Empty: the arena file’s (3).',
      },
      {
        key: 'WAR_SERIES',
        label: 'Series',
        type: 'number',
        help: 'How many series the referee plays; empty: the arena file’s (3).',
      },
    ],
  },
]

export const SETTINGS: Setting[] = SECTIONS.flatMap((s) => s.settings)

export function setting(key: string): Setting | undefined {
  return SETTINGS.find((s) => s.key === key)
}

/** Why a value cannot be saved for a setting (undefined: it can). Empty is always allowed. */
export function invalid(key: string, value: string): string | undefined {
  const s = setting(key)
  if (/[\r\n]/.test(value)) return 'one line only'
  if (!s || value === '') return undefined
  if (s.managed) return 'set by the container, not by .env'
  if (s.type === 'number' && !Number.isFinite(Number(value))) return 'must be a number'
  if (s.type === 'bool' && !/^(true|false|1|0|yes|no|on|off)$/i.test(value)) return 'true or false'
  if (s.type === 'select' && !s.options?.includes(value))
    return `one of ${s.options?.filter(Boolean).join(', ')}`
  if (s.type === 'point' && !/^-?\d+\s*,\s*-?\d+\s*,\s*-?\d+$/.test(value)) return '"x,y,z"'
  if (key === 'DATABASE_URL' && !/^postgres(ql)?:\/\/\S+$/.test(value))
    return 'a URL like postgres://court:password@127.0.0.1:5432/court'
  if (key === 'OLLAMA_HOST' && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(value))
    return 'a URL like http://host:11434'
  return undefined
}
