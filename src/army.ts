import fs from 'node:fs'
import path from 'node:path'
import type { Mine, MineRecord } from './bot/mining'

/** What a soldier wears and carries: the material of each piece (undefined: none). */
export interface Gear {
  head?: string
  chest?: string
  legs?: string
  feet?: string
  /** The best sword (or axe) carried. */
  sword?: string
  shield: boolean
}

export type Piece = 'head' | 'chest' | 'legs' | 'feet'
export const PIECES: Piece[] = ['head', 'chest', 'legs', 'feet']
const ITEM: Record<Piece, string> = {
  head: 'helmet',
  chest: 'chestplate',
  legs: 'leggings',
  feet: 'boots',
}

const ARMOUR_TIER: Record<string, number> = {
  leather: 1,
  copper: 2,
  golden: 3,
  chainmail: 4,
  iron: 5,
  turtle: 5,
  diamond: 6,
  netherite: 7,
}
const SWORD_TIER: Record<string, number> = {
  wooden: 1,
  golden: 1,
  stone: 2,
  copper: 3,
  iron: 4,
  diamond: 5,
  netherite: 6,
}

/** How good armour of this material is (0: none). */
export function armourTier(material: string | undefined): number {
  return ARMOUR_TIER[material ?? ''] ?? 0
}

/** How good a sword of this material is (0: none). */
export function swordTier(material: string | undefined): number {
  return SWORD_TIER[material ?? ''] ?? 0
}

/** "iron" from "iron_chestplate", undefined for nothing worn. */
export function materialOf(item: string | undefined): string | undefined {
  return item ? item.replace(/_(helmet|chestplate|leggings|boots|sword|axe)$/, '') : undefined
}

/** The best sword or axe among these items. */
export function bestSword(items: string[]): string | undefined {
  return items
    .filter((i) => /_(sword|axe)$/.test(i))
    .map(materialOf)
    .sort((a, b) => (SWORD_TIER[b ?? ''] ?? 0) - (SWORD_TIER[a ?? ''] ?? 0))[0]
}

/** One command of the blessing, with what takes it back after a day. */
export interface BlessingStep {
  to: string
  item: string
  command: string
  undo: string
}

/**
 * "Bless the Army" (the King's spell, 2026-10-31): copper armour, a copper sword and a shield for
 * every soldier, iron for the leader; only where what they have is worse, piece by piece.
 */
export function blessingSteps(soldiers: Record<string, Gear>, leader: string): BlessingStep[] {
  const steps: BlessingStep[] = []
  const q = (name: string) => `"${name}"`
  for (const [name, gear] of Object.entries(soldiers)) {
    const metal = name === leader ? 'iron' : 'copper'
    for (const piece of PIECES) {
      if ((ARMOUR_TIER[gear[piece] ?? ''] ?? 0) >= ARMOUR_TIER[metal]) continue
      const item = `${metal}_${ITEM[piece]}`
      steps.push({
        to: name,
        item,
        command: `replaceitem entity ${q(name)} slot.armor.${piece} 0 ${item}`,
        undo: `clear ${q(name)} ${item} -1 1`,
      })
    }
    if ((SWORD_TIER[gear.sword ?? ''] ?? 0) < SWORD_TIER[metal]) {
      const item = `${metal}_sword`
      steps.push({
        to: name,
        item,
        command: `give ${q(name)} ${item} 1`,
        undo: `clear ${q(name)} ${item} -1 1`,
      })
    }
    if (!gear.shield)
      steps.push({
        to: name,
        item: 'shield',
        command: `replaceitem entity ${q(name)} slot.weapon.offhand 0 shield`,
        undo: `clear ${q(name)} shield -1 1`,
      })
  }
  return steps
}

/** Does anyone lack what the blessing would give? */
export function wantsBlessing(soldiers: Record<string, Gear>, leader: string): boolean {
  return blessingSteps(soldiers, leader).length > 0
}

/** The army's report to the household's mind: its soldiers' gear, and a blessing asked for. */
export interface ArmyReport {
  at: number
  leader: string
  soldiers: Record<string, Gear>
  /** The King said yes to Sarge: Merlin is to bless the army. */
  request?: { by: string; at: number }
}

/** The household's answer: when Merlin last blessed the army, and which request that was. */
export interface Blessing {
  at: number
  by: string
  requestAt?: number
}

/** The two files between the minds of one world (in its .state). */
/** A soldier's ask for Merlin's portal: when, and to which of the court's places. */
export interface PortalAsk {
  at: number
  place: string
}

export class ArmyBoard implements MineRecord {
  constructor(private readonly dir: string) {}

  report(): ArmyReport | undefined {
    return this.read<ArmyReport>('army.json')
  }

  writeReport(report: ArmyReport): void {
    this.write('army.json', report)
  }

  blessing(): Blessing | undefined {
    return this.read<Blessing>('blessing.json')
  }

  writeBlessing(blessing: Blessing): void {
    this.write('blessing.json', blessing)
  }

  /**
   * Soldiers asking the household's Merlin for a portal: home (woken at the world spawn), or the
   * storehouse when there is no way there on foot. name -> when asked, and where to. The army
   * has no Merlin of its own.
   */
  portals(): Record<string, PortalAsk> {
    const asked = this.read<Record<string, number | PortalAsk>>('army-portals.json') ?? {}
    return Object.fromEntries(
      Object.entries(asked).map(([name, ask]) => [
        name,
        typeof ask === 'number' ? { at: ask, place: 'home' } : ask,
      ])
    )
  }

  askPortal(name: string, now = Date.now(), place = 'home'): void {
    this.write('army-portals.json', { ...this.portals(), [name]: { at: now, place } })
  }

  /**
   * What a soldier last saw in the storehouse (the household's mind keeps the court's account
   * of it; the army's hunters and miners put things in too).
   */
  stock(): { items: Record<string, number>; at: number } | undefined {
    return this.read<{ items: Record<string, number>; at: number }>('army-stock.json')
  }

  writeStock(items: Record<string, number>, at = Date.now()): void {
    this.write('army-stock.json', { items, at })
  }

  /** The army's own mine (the household digs its own): see bot/mining.ts. */
  get mine(): Mine | undefined {
    return this.read<{ mine?: Mine }>('army-mine.json')?.mine
  }

  setMine(mine: Mine): void {
    this.write('army-mine.json', { mine: { ...mine }, old: this.oldMines })
  }

  get oldMines(): Array<[number, number]> {
    return this.read<{ old?: Array<[number, number]> }>('army-mine.json')?.old ?? []
  }

  retireMine(mine: Mine): void {
    const old = [...this.oldMines, [mine.x, mine.z] as [number, number]].slice(-12)
    this.write('army-mine.json', { old })
  }

  private read<T>(name: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as T
    } catch {
      return undefined
    }
  }

  private write(name: string, data: unknown): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, name)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }
}
