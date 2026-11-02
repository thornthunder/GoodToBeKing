import fs from 'node:fs'
import path from 'node:path'
import type { Gear } from './army'

/**
 * What one court process is and does right now, written every few seconds to
 * `.state/status-<division>.json` for the admin (src/admin): who is online, where, how they fare
 * and what they are at. Read only by the admin; nothing in the court reads it back.
 */
export interface CourtStatus {
  /** When it was written (ms since the epoch); an old one means the process is gone. */
  at: number
  /** This process's mind: "household", "army", or "all" when one process runs every bot. */
  division: string
  /** This process's world (COURT_WORLD), if the court has two. */
  world?: string
  /** The world the court is in now. */
  courtWorld?: string
  process: { pid: number; startedAt: number; rssMb: number; heapMb: number; lagMs: number }
  bots: BotSnapshot[]
  /** Players online, as the first bot online sees them. */
  players: PlayerSnapshot[]
  home?: { x: number; y: number; z: number }
  /** The household's work under way and resting (the steward's kinds of job). */
  underway: string[]
  resting: string[]
  /** Merlin's magic left this hour, when this process has him. */
  magicLeft?: number
  /** The war game (src/war): this process is one side of it. */
  war?: {
    side: string
    phase: string
    done: boolean
    brought: number
    kills: number
    deaths: number
  }
}

export interface BotSnapshot {
  name: string
  role: string
  division: string
  status: string
  position?: { x: number; y: number; z: number }
  health?: number
  food?: number
  gameMode?: string
  free: boolean
  /** What it is at, in a few words ("mining", "on patrol", "asleep"). */
  doing?: string
  /** Its standing order that keeps it busy, if any. */
  post?: string
  gear?: Gear
  /** Where it wakes after dying: undefined = unknown, null = the world spawn. */
  spawnPoint?: { x: number; y: number; z: number } | null
}

export interface PlayerSnapshot {
  name: string
  /** The royal's title, if a royal. */
  title?: string
  position?: { x: number; y: number; z: number }
}

/** Write the status beside the rest of the state, whole (a reader never sees half a file). */
export function writeStatus(file: string, status: CourtStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(status))
  fs.renameSync(tmp, file)
}
