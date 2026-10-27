import fs from 'node:fs'
import path from 'node:path'

/** One member of the royal family, identified by their in-game player name. */
export interface CourtMember {
  /** In-game player name (gamertag). Matched case-insensitively. */
  player: string
  /** Free-form role, e.g. "princess" or "king". */
  role: string
  /** Title used when talking about them, e.g. "Princess". */
  title: string
  /** How to address them directly, e.g. "Your Highness". */
  address: string
  /** Extra guidance for the bots about this person. */
  notes?: string
}

export interface CourtConfig {
  /** Name of the realm, used in prompts. */
  realm: string
  /** What the court is for and how every bot should behave towards the royal family. */
  charter: string
  members: CourtMember[]
  /** File the roster was loaded from; undefined when no file was found. */
  file?: string
}

const EMPTY_COURT: CourtConfig = { realm: 'the realm', charter: '', members: [] }

function isMember(value: unknown): value is CourtMember {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return ['player', 'role', 'title', 'address'].every(
    (key) => typeof m[key] === 'string' && (m[key] as string).trim() !== ''
  )
}

/** Load the roster from a JSON file. A missing file yields an empty court rather than an error. */
export function loadCourt(file: string): CourtConfig {
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) return { ...EMPTY_COURT }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Partial<CourtConfig>
  const members = parsed.members ?? []
  if (!Array.isArray(members)) throw new Error(`${resolved}: "members" must be an array`)
  members.forEach((m, i) => {
    if (!isMember(m)) {
      throw new Error(`${resolved}: members[${i}] needs non-empty player, role, title and address`)
    }
  })
  return {
    realm: parsed.realm?.trim() || EMPTY_COURT.realm,
    charter: parsed.charter?.trim() ?? '',
    members,
    file: resolved,
  }
}

/** Read-only view of the court used by the brains. */
export class CourtRoster {
  private readonly byName: Map<string, CourtMember>

  constructor(readonly cfg: CourtConfig) {
    this.byName = new Map(cfg.members.map((m) => [m.player.toLowerCase(), m]))
  }

  get members(): CourtMember[] {
    return this.cfg.members
  }

  find(player: string): CourtMember | undefined {
    return this.byName.get(player.toLowerCase())
  }

  /** How to name a player inside a prompt: royals get their title next to the player name. */
  label(player: string): string {
    const m = this.find(player)
    return m ? `${player} (the ${m.title})` : player
  }

  /** Prompt section describing the court. Empty when there is no roster. */
  describe(): string {
    if (this.cfg.members.length === 0) return ''
    const lines = [`The royal court of ${this.cfg.realm}:`]
    if (this.cfg.charter) lines.push(this.cfg.charter)
    for (const m of this.cfg.members) {
      lines.push(
        `- ${m.player} is the ${m.title}. Address them as "${m.address}" and speak of them as ` +
          `"the ${m.title}", never by player name.${m.notes ? ` ${m.notes}` : ''}`
      )
    }
    lines.push('Any other player is a guest of the realm: be friendly and polite to them.')
    return lines.join('\n')
  }
}
