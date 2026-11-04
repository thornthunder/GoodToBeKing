import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { CourtMemory } from '../ai/CourtMemory'
import { CourtRules, OrderBook, confirmation, rankOf } from '../ai/orders'
import type { ChatEvent } from '../ai/Brain'
import { isGetMeHome } from '../ai/text'
import { HailLog } from '../ai/HailLog'
import { Magic } from '../magic/Magic'
import { placesFromFiles, type Place } from '../magic/places'
import { OllamaBrain } from '../ai/OllamaBrain'
import { OllamaClient } from '../ai/OllamaClient'
import { slug } from '../build/compile'
import { BuildLog } from '../build/BuildLog'
import type { BuildOutcome } from '../ai/Brain'
import {
  BLUEPRINT_IDS,
  DEFAULT_PALETTE,
  makeBlueprint,
  type BlueprintId,
  type Palette,
} from '../build/blueprints'
import { CommissionBook, type Commission } from '../build/Commissions'
import type { Point } from '../build/site'
import { compileDesign } from '../build/compile'
import { validateDesign, type CastleDesign } from '../build/design'
import { Works, type Worker, type WorksEvent } from '../build/Works'
import { findCastleSites } from '../build/sites'
import { NEEDED, Overlord, coveredNeeds, overlordClient } from '../ai/Overlord'
import type { Rect } from '../build/design'
import type { AppConfig } from '../config'
import { CourtRoster, type CourtMember } from '../court'
import type { Logger } from '../logger'
import { record } from '../db/history'
import { errMsg, sleep } from '../util'
import { Bot } from './Bot'
import { MATERIALS, type Material } from './gathering'
import { Household } from '../household'
import { EstateBook } from '../build/EstateBook'
import {
  darkSpots,
  estateDoorCells,
  estateLightCells,
  estateRepairCells,
  estateWords,
  homeRoom,
  surveyEstate,
  type Estate,
} from '../build/estate'
import type { Hall } from '../build/hall'
import type { Zone } from '../build/site'
import {
  doorCells,
  lightCells,
  reinforceCells,
  repairCells,
  roofCells,
  surveyHall,
  tableCells,
} from '../build/hall'
import { plan, type CourtState, type MagicWant, type StewardAction } from '../steward'
import { Presence, worldWords } from '../presence'
import { ArmyBoard, blessingSteps, wantsBlessing, type Gear } from '../army'
import { RAW } from './cooking'
import { MAX_FIELD, PLOT_SEEDS, farmNeed } from '../build/farm'
import { groveNeed } from '../build/grove'
import { FOODS } from './survival'
import type { HallWork } from '../ai/Brain'
import { ChatFloor, FilePartners } from './ChatFloor'
import { writeStatus } from '../status'
import type { InDatabase, SharedState } from '../db/shared'
import { sideTitle, warSide } from '../war/side'
import { WarBook } from '../war/War'
import { Playbook } from '../war/playbook'
import { gearWords, planRaid, type Brief } from '../war/plan'
import { councilLine, holdCouncil, type Council, type CouncilBrief } from '../war/council'
import { metalWords, timeline } from '../war/referee'
import { chooseLure, CREEPER_WATCH, LURE_MS } from './creepers'

/** Runtime state that should survive restarts (git-ignored). */
const STATE_DIR = '.state'
/**
 * What goes with each courtier from world to world (memories, orders, hails), the royals' rules,
 * and where the court is: one folder for the courts of both worlds (SHARED_STATE_DIR), unless they
 * are in the database (DATABASE_URL; the folder's files are taken in once, see importFiles.ts).
 */
export const SHARED_DIR = process.env.SHARED_STATE_DIR || STATE_DIR
/** This court's world ("dev", "creative"); unset: one world, every bot in it. */
const WORLD = process.env.COURT_WORLD
/** The world the court lives in when the King has not called it away. */
const HOME_WORLD = process.env.COURT_HOME_WORLD || 'dev'
/**
 * The mind this process is (COURT_DIVISION): "household" (Festaris's staff and Merlin: food,
 * construction, supplies, repairs) or "army" (Sarge's soldiers: security). Unset: one mind, all.
 */
const DIVISION = process.env.COURT_DIVISION as 'household' | 'army' | undefined
/** The household's mind keeps house, the works and the estate; the army only follows them. */
const HOUSEHOLD = DIVISION !== 'army'
/** The war game (src/war): this process is one side of it (COURT_SIDE), or not at war. */
const SIDE = warSide()
/** Players the court neither hears nor hails (our tools' Surveyor, the war game's sides). */
const IGNORED = new Set(
  (process.env.IGNORE_PLAYERS ?? 'Surveyor')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
)
/** A raid planned for day or night sets out then, or after this long anyway (a day is 20 min). */
const WHEN_WAIT_MS = 25 * 60_000
/** A metals round: the captain's council once a Minecraft day; the mine goes this deep (gold). */
const COUNCIL_MS = Number(process.env.WAR_COUNCIL_MS) || 20 * 60_000
const METALS_MINE_DEPTH = Number(process.env.WAR_MINE_DEPTH) || 64

/** How often this process writes its status for the admin. */
const STATUS_MS = 5_000
/** A palace a royal orders goes up within this many blocks of the spot they chose. */
const ORDERED_RADIUS = 48
/** A new home further than this from the old one: the court moves house. */
const MOVE_FROM = 32
/** The estate round home is surveyed this often (and soon after a royal makes a home). */
const ESTATE_MS = 10 * 60_000
/** A block gone this close to where a royal was lately is taken for the royals' doing. */
const ROYAL_NEAR = 12
const ROYAL_TRAIL_MS = 2 * ESTATE_MS
/**
 * This many of the court dead at home within OVERRUN_MS, by night: the home is overrun (a dark
 * house full of monsters), and nobody is sent back into it till morning. Merlin's portals once
 * brought the dead straight back to die again, a dozen times in two minutes.
 */
const OVERRUN_DEATHS = 3
const OVERRUN_MS = 5 * 60_000
const OVERRUN_NEAR = 32

/** A new palace or castle a royal ordered, waiting for its plans. */
interface OrderedWorks {
  /** "palace", "castle" */
  what: string
  requestedBy: string
  /** "the King" */
  by: string
  near: Point
  at: number
}

interface CourtWorks {
  current?: string
  built: string[]
  /** Ordered by a royal: planned as soon as the crew is free. */
  ordered?: OrderedWorks
}

/** At most one exchange of work talk between bots this often. */
const CHATTER_GAP_MS = 40_000
/** No work talk this soon after a royal spoke: their conversation comes first. */
const ROYAL_QUIET_MS = 90_000

/** Creates and supervises every configured bot. */
export class BotManager {
  readonly bots: Bot[] = []
  /** Creepers near home being lured away: entity id → who lures it and since when. */
  private readonly lures = new Map<number, { name: string; since: number }>()
  works?: Works
  private worksTimer?: NodeJS.Timeout
  /** Writes this process's status for the admin (see status.ts). */
  private statusTimer?: NodeJS.Timeout
  private readonly lag = monitorEventLoopDelay({ resolution: 20 })
  private readonly startedAt = Date.now()
  private lastChatter = 0
  private lastRoyalLine = 0
  private milestone = 0
  /** All bots have had their first go at connecting; the works may begin. */
  private ready = false
  private planning = false
  private readonly cfg: AppConfig
  private readonly court: CourtRoster
  /** The builds the royal family asked for, and who is on them. */
  readonly commissions = new CommissionBook(path.resolve(STATE_DIR, 'commissions.json'))
  /** The war game: this side's account of it, and the lessons it has drawn (COURT_SIDE). */
  private readonly war?: WarBook
  private readonly playbook?: Playbook
  /** A raid waiting for its hour (day or night); cancelled when the raid is called off. */
  private raidWait?: { cancel: boolean }
  /** A metals round (src/war/council.ts): when it opened, its days, the next council, the last. */
  private metals?: {
    openedAt: number
    days: number
    timer?: NodeJS.Timeout
    lastCouncil: number
    holding: boolean
  }
  /** What a raider of ours last saw in the other side's chest. */
  private enemySeen?: { items: Record<string, number>; at: number }

  constructor(
    cfg: AppConfig,
    private readonly log: Logger,
    /** The court's shared state in the database (DATABASE_URL); without it, files. */
    shared?: SharedState
  ) {
    this.cfg = cfg
    if (SIDE) {
      this.war = new WarBook(path.resolve(STATE_DIR, 'war.json'), SIDE.name)
      this.war.mine = new Set(cfg.bots.map((b) => b.name.toLowerCase()))
      this.playbook = new Playbook(path.resolve(STATE_DIR, 'playbook.json'))
      log.info(
        `the war game: this is the ${SIDE.name} side; the enemy is ${SIDE.enemy.name} (${SIDE.enemy.names.join(', ')})`
      )
    }
    // Memories, orders, hails, rules and where the court is: in the database, else in files.
    const keep = (file: string, bot?: string): string | InDatabase =>
      shared ? { shared, bot } : path.resolve(SHARED_DIR, file)
    this.presence = WORLD ? new Presence(keep('presence.json'), WORLD, HOME_WORLD) : undefined
    const court = new CourtRoster(cfg.court)
    this.court = court
    const botNames = cfg.bots.map((b) => b.name)
    // This mind's bots; the other mind's are fellow courtiers it does not run.
    const mine = cfg.bots.filter((b) => !DIVISION || (b.division ?? 'household') === DIVISION)
    const mineNames = mine.map((b) => b.name)
    const foreign = botNames.filter((n) => !mineNames.includes(n))
    // Who speaks: bots in configured order for the royals; the Castellan first for guests.
    const castellanFirst = [...mineNames].sort(
      (a, b) => Number(isCastellan(cfg, b)) - Number(isCastellan(cfg, a))
    )
    // "GMH" (Get Me Home) from a royal is Merlin's to answer: he takes them to the hall.
    const wizard = cfg.bots.find((b) => b.magic)?.name
    const floor = new ChatFloor(
      mineNames,
      castellanFirst,
      (event) =>
        wizard && isGetMeHome(event.message) && court.find(event.from) ? wizard : undefined,
      {
        foreign,
        herald: HOUSEHOLD,
        partners: DIVISION ? new FilePartners(path.resolve(STATE_DIR, 'floor.json')) : undefined,
      }
    )
    const staff = cfg.bots.map((b) => ({
      name: b.name,
      role: b.role,
      canBuild: b.canBuild,
      reportsTo: b.reportsTo,
    }))
    // The rules the royal family lays down bind the whole court.
    const rules = new CourtRules(keep('rules.json'))
    // What each bot built, so "take it down" removes only that bot's own blocks.
    const builds = new BuildLog(path.resolve(STATE_DIR, 'builds.json'))
    for (const botCfg of mine) {
      const botLog = log.child(botCfg.name)
      const ai = new OllamaClient(botCfg.ai, botLog.child('ollama'))
      const hails = new HailLog(keep(`${botCfg.name}.hails.json`, botCfg.name))
      const magic = botCfg.magic
        ? (this.magic = new Magic({
            file: path.resolve(STATE_DIR, `magic-${botCfg.name.toLowerCase()}.json`),
            // The court's bots online, of either mind (a gathering tps only those).
            court: () =>
              botNames.filter((n) => this.bots.some((b) => b.cfg.magic && b.isOnline(n))),
            places: () => this.places(),
          }))
        : undefined
      const brain = new OllamaBrain(botCfg, ai, court, botLog.child('brain'), {
        household: this.household,
        hails,
        // Each bot remembers only what it heard itself, so one can keep a secret and news
        // travels by being told.
        memory: new CourtMemory(keep(`memory-${botCfg.name.toLowerCase()}.json`, botCfg.name)),
        staff,
        orders: new OrderBook(keep(`orders-${botCfg.name.toLowerCase()}.json`, botCfg.name)),
        rules,
        magic,
        commissions: this.commissions,
        realm: this.presence && {
          here: this.presence.here,
          home: this.presence.home,
          courtIn: () => this.presence?.world ?? '',
        },
      })
      const bot = new Bot(botCfg, brain, botLog, {
        // Our own helper scripts' players (the surveyor) are ignored like fellow bots.
        fellowBots: [...botNames, ...IGNORED],
        enemies: SIDE?.enemy.names,
        buildLog: builds,
        floor,
        court,
        works: () => this.worksLine(),
        magic,
        household: this.household,
        estate: this.estate,
      })
      bot.on('chat', (event: ChatEvent) => {
        this.heard(bot, event)
        if (court.find(event.from)) this.lastRoyalLine = Date.now()
        // Every bot hears the line: the Castellan's ears are the ones that count.
        if (bot === this.castellan()) this.kingAnswers(event)
        if (bot === this.sarge()) this.kingBlesses(event)
      })
      bot.on('commission', (request: CommissionRequest) => this.commission(bot, request))
      bot.on('summonCourt', (by: string) => this.summonCourt(bot, by))
      bot.on('blessArmy', (by: string) => void this.blessArmy(bot, by))
      bot.on('works', (order: WorksOrder) => void this.orderWorks(bot, order))
      bot.on('gather', (errand: Errand) => void this.sendOnErrand(bot, errand))
      bot.on(
        'hallwork',
        (job: { work: HallWork; requestedBy: string }) => void this.sendToHall(bot, job)
      )
      bot.on('home', (h: { requestedBy: string; at?: Point }) => {
        // Where the royal stands, as any courtier sees it; out of everyone's sight it is nowhere
        // yet (the line reaches the whole world): they are asked to come where the court can see.
        const at = h.at ?? this.bots.map((b) => b.playerPosition(h.requestedBy)).find(Boolean)
        if (at) return this.makeHome(at, h.requestedBy)
        const member = this.court.find(h.requestedBy)
        const who = member ? `the ${member.title}` : h.requestedBy
        void bot.speak(
          `${capital(who)} wants the court's home where they stand, but no courtier can see them, ` +
            'so you do not know where that is. Ask kindly, in one short sentence, to call the ' +
            'court there first (Merlin can gather everyone) and say it again once the court is there.',
          'Where is that? Call us there first, and we shall make it our home.'
        )
      })
      bot.on('storehouse', (s: { requestedBy: string; at: Point }) => {
        if (this.household.storehouse && samePoint(this.household.storehouse, s.at)) return
        this.household.setStorehouse(s.at, s.requestedBy)
        this.placesCache = undefined
        this.log.info(
          `${s.requestedBy} made the chest at ${s.at.x},${s.at.y},${s.at.z} the storehouse`
        )
      })
      // Far out with the storehouse to reach: Merlin brings the courtier home (travel is free).
      bot.on('blast', (at: Point) => this.noteBlast(at))
      bot.on('died', (at?: Point) => {
        const home = this.household.home
        if (at && home && Math.hypot(at.x - home.x, at.z - home.z) < OVERRUN_NEAR)
          this.deathsAtHome.push(Date.now())
      })
      bot.portalHome = async () => {
        const merlin = this.bots.find((b) => b.magicAwake())
        if (!merlin || bot.buildsByMagic() || !this.household.home) return false
        if (this.homeOverrun(bot)) return false
        this.log.info(`${merlin.cfg.name} brings ${bot.cfg.name} home from afar by portal`)
        await merlin.castCommand('portal', {
          target: bot.cfg.name,
          requestedBy: merlin.cfg.name,
          args: { place: 'home' },
        })
        return true
      }
      // Each mind digs its own mine, clear of the other's; the army's sightings of the
      // storehouse reach the household's account of it.
      if (!HOUSEHOLD) {
        bot.mines = this.board
        bot.onStock = (items) => this.board.writeStock(items)
      }
      bot.otherMines = () => {
        const other = HOUSEHOLD ? this.board.mine : this.household.mine
        return other ? [[other.x, other.z]] : []
      }
      // To a named place (the storehouse left behind), by Merlin's portal.
      bot.portalTo = async (place: string) => {
        const merlin = this.bots.find((b) => b.magicAwake())
        // The army asks the household's Merlin, and waits a while for him.
        if (!merlin && !HOUSEHOLD && place === 'the storehouse' && !bot.buildsByMagic()) {
          const from = bot.position()
          this.log.info(`${bot.cfg.name} asks the household's Merlin for a portal to ${place}`)
          this.board.askPortal(bot.cfg.name, Date.now(), place)
          for (let i = 0; i < 20; i++) {
            await sleep(1_000)
            const p = bot.position()
            if (from && p && Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) > 4) return true
          }
          return false
        }
        if (!merlin || bot.buildsByMagic()) return false
        this.placesCache = undefined
        this.log.info(`${merlin.cfg.name} sends ${bot.cfg.name} to ${place} by portal`)
        await merlin.castCommand('portal', {
          target: bot.cfg.name,
          requestedBy: merlin.cfg.name,
          args: { place },
        })
        return true
      }
      this.bots.push(bot)
    }
    // Carry on with whatever the court was last building (the overlord's design, once there is one).
    const current = this.courtWorks().current ?? cfg.worksDesign
    if (current && HOUSEHOLD) this.startWorks(current)
  }

  /**
   * A royal makes a place the court's home. Far from the old one the court moves house: the
   * field, the mine, the grove and the storehouse start afresh round it (what the old storehouse
   * holds is carried over), everyone puts down the court's work round the old home and comes,
   * and the Castellan surveys what stands there, to keep and look after rather than build anew.
   */
  private makeHome(at: Point, by: string): void {
    const old = this.household.home
    const moving = old !== undefined && Math.hypot(at.x - old.x, at.z - old.z) > MOVE_FROM
    const home = moving ? this.household.moveHome(at, by) : this.household.setHome(at, by)
    this.placesCache = undefined
    this.homeTrips.clear()
    this.estateRoom = undefined
    this.estateWork = undefined
    this.newHome = { by, at: Date.now() }
    if (moving) {
      // The old home's work rests and underway say nothing about the new one.
      this.resting.clear()
      this.underway.clear()
      for (const b of this.bots) b.dropCourtWork()
    }
    const said = `${by} made ${home.x},${home.y},${home.z} the court's home${moving ? ': the court moves house' : ''}`
    this.log.info(said)
    record({ kind: 'court', actor: by, text: said, data: { home } })
  }

  /** When courtiers died at home lately. */
  private deathsAtHome: number[] = []
  private overrunSaid = false

  /** Several of the court died at home lately, and it is still dark: no place to send anyone. */
  private homeOverrun(bot: Bot): boolean {
    const now = Date.now()
    this.deathsAtHome = this.deathsAtHome.filter((t) => now - t < OVERRUN_MS)
    const dark = bot.isNight() || !bot.outdoorTime()
    if (!dark) {
      this.deathsAtHome = []
      this.overrunSaid = false
    }
    return dark && this.deathsAtHome.length >= OVERRUN_DEATHS
  }

  /** The Castellan: no builder himself, with staff who report to him. */
  private castellan(): Bot | undefined {
    return this.bots.find(
      (b) => !b.cfg.canBuild && this.bots.some((w) => w.cfg.reportsTo === b.cfg.name)
    )
  }

  /** What stands round the court's home, as last seen whole. */
  private readonly estate = new EstateBook(path.resolve(STATE_DIR, 'estate.json'))
  /** Where the royals were lately: a block gone near them was theirs to take away. */
  private royalTrail: Array<{ x: number; z: number; at: number }> = []
  private lastEstate = 0
  private surveying = false
  /** Surveyed since this start: changes made while the court was away are the royals' too. */
  private estateSeen = false
  /** A royal just made a home: it is surveyed as soon as a courtier is there, and reported. */
  private newHome?: { by: string; at: number }
  /** The room the home is in, when the home is in a castle (its walls do not close a hall). */
  private estateRoom?: Hall
  /** The estate's furniture round home, as last surveyed. */
  private estateFurniture: Estate['furniture'] = {}
  /** What the estate wants, in blocks (see steward.ts). */
  private estateWork?: { repair: number; doors: number; light: number }

  private noteRoyals(): void {
    const now = Date.now()
    for (const m of this.court.members) {
      const p = this.bots.map((b) => b.playerPosition(m.player)).find(Boolean)
      if (p) this.royalTrail.push({ x: p.x, z: p.z, at: now })
    }
    this.royalTrail = this.royalTrail.filter((p) => now - p.at < ROYAL_TRAIL_MS)
  }

  private royalWasNear(x: number, z: number): boolean {
    return this.royalTrail.some((p) => Math.hypot(p.x - x, p.z - z) < ROYAL_NEAR)
  }

  /**
   * The court's estate: surveyed soon after a royal made the home (and the Castellan says what
   * he found), then every ESTATE_MS, so damage can be told from what the royals changed.
   */
  private async upkeepEstate(): Promise<void> {
    const home = this.household.home
    if (!home || this.surveying) return
    const report = this.newHome
    const due = report ? Date.now() - report.at > 8_000 : Date.now() - this.lastEstate > ESTATE_MS
    if (!due) return
    // Someone at home, where the chunks round it are loaded (sendHome brings them).
    const eyes = this.bots.find((b) => {
      const p = b.position()
      return p && Math.hypot(p.x - home.x, p.z - home.z) < 16 && Math.abs(p.y - home.y) < 8
    })
    const names = eyes?.fastNames()
    if (!names) return
    this.surveying = true
    try {
      this.lastEstate = Date.now()
      this.newHome = undefined
      const estate = surveyEstate(names, home)
      const dark = darkSpots(estate, names).length
      const words = estateWords(estate, dark)
      this.household.setEstate(estate.buildings, words)
      if (report || !this.estate.of(home))
        this.estate.found(estate, words, report?.by ?? home.setBy)
      else
        this.estate.update(
          estate,
          words,
          // The first look after a start: whatever changed meanwhile is taken as it is.
          (x, z, y) => !this.estateSeen || (this.royalWasNear(x, z) && !this.blownAway(x, y, z)),
          (x, y, z) => names(x, y, z) !== undefined
        )
      this.estateSeen = true
      this.estateRoom = homeRoom(estate, names)
      this.estateFurniture = estate.furniture
      const stock = this.household.stock.items
      this.estateWork = {
        repair: estateRepairCells(
          this.estate.of(home)?.made ?? {},
          names,
          (b) => (stock[b] ?? 0) > 0
        ).filter((c) => this.estate.finished(home) || !this.household.hallColumn(c.x, c.z)).length,
        doors: estateDoorCells(estate, names, 4, this.estate.of(home)?.made).length,
        light: estateLightCells(estate, names, 16).length,
      }
      this.log.info(`estate: ${words} Wants: ${JSON.stringify(this.estateWork)}`)
      if (report) await this.reportEstate(estate, words, dark, report.by)
    } catch (err) {
      this.log.warn(`surveying the estate failed: ${errMsg(err)}`)
    } finally {
      this.surveying = false
    }
  }

  /** The Castellan tells the royal who made the home what stands there, and what the court will do. */
  private async reportEstate(
    estate: Estate,
    words: string,
    dark: number,
    by: string
  ): Promise<void> {
    const speaker = this.castellan() ?? this.foreman()
    if (!speaker) return
    const member = this.court.find(by)
    const who = member ? `the ${member.title}` : by
    if (!estate.buildings.length) {
      await speaker.speak(
        `You have looked round the court's new home, which ${who} chose: nothing anyone built ` +
          'stands there yet. Tell them gladly in one short sentence that the court settles here ' +
          'and makes the place its own.',
        'We settle here gladly and make the place our own!'
      )
      return
    }
    const plans = [
      estate.doorless.length &&
        `hang doors in the ${estate.doorless.length} ways in that have none`,
      dark && 'light the dark corners with torches so no monster spawns there',
      'mend any damage',
      this.household.formerStore && 'carry the old storehouse over',
    ].filter(Boolean)
    const rooms = estate.buildings.flatMap((b) => b.rooms)
    const kinds = [...new Set(rooms.map((r) => r.kind))]
    const found =
      `${estate.buildings.length === 1 ? 'one building' : `${estate.buildings.length} buildings`}` +
      ` with ${rooms.length} room${rooms.length === 1 ? '' : 's'}` +
      (kinds.length ? ` (${kinds.map((k) => `a ${k}`).join(', ')})` : '')
    await speaker.speak(
      `You have just walked round the court's new home, which ${who} chose. In short you found ` +
        `${found}. In detail: ${words} Tell ${who} in two or three short sentences what you ` +
        'found (how many rooms, and what they are), and what the court will do: it keeps the ' +
        'place as it stands, pulls nothing down and builds nothing that is there already, and ' +
        `it will ${plans.join(', ')}. Do not say it was planned or built by the court.`,
      `I have looked round our new home: ${found}. We shall keep it as it stands, light it and mend it.`
    )
  }

  /** Where the court builds of its own accord: round the home a royal chose, else its zone. */
  private buildZone(): Zone | undefined {
    const zone = this.bots.find((b) => b.cfg.buildZone)?.cfg.buildZone
    const home = this.household.home
    if (home && this.court.find(home.setBy))
      return { center: { x: home.x, y: home.y, z: home.z }, radius: zone?.radius ?? 100 }
    return zone
  }

  /**
   * Courtiers with nothing to do go home: on foot when it is near, by Merlin's portal (travel is
   * free) when it is far or the walk failed twice.
   */
  private sendHome(): void {
    const home = this.household.home
    if (!home) return
    const now = Date.now()
    for (const bot of this.bots) {
      const p = bot.position()
      if (!p) continue
      // Overrun by night: whoever is away (woken at the world spawn) stays away till morning.
      if (this.homeOverrun(bot) && Math.hypot(p.x - home.x, p.z - home.z) > OVERRUN_NEAR) {
        if (!this.overrunSaid) {
          this.log.info('the home is overrun: nobody goes back till morning')
          record({ kind: 'court', text: 'the home is overrun: nobody goes back till morning' })
        }
        this.overrunSaid = true
        continue
      }
      const far = Math.hypot(p.x - home.x - 0.5, p.z - home.z - 0.5)
      // Dusk: whoever is still far out on the court's errands is brought home (travel is free).
      const busy = !bot.isFree()
      if (busy) {
        if (!(bot.onErrand() && bot.duskFallen() && far > DUSK_FAR && !bot.buildsByMagic()))
          continue
      }
      // In survival everyone comes inside the hall outside the hours for outdoor work (the dusk
      // and the first light are when the monsters are about too); by day near it will do.
      const indoors = (bot.isNight() || !bot.outdoorTime()) && !bot.buildsByMagic()
      const radius = indoors ? HOME_RADIUS_NIGHT : HOME_RADIUS
      if (far <= radius && Math.abs(p.y - home.y) < 2) {
        this.homeTrips.delete(bot.cfg.name)
        continue
      }
      const trip = this.homeTrips.get(bot.cfg.name) ?? { at: 0, walks: 0 }
      if (now - trip.at < HOME_RETRY_MS) continue
      const merlin = this.bots.find((b) => b.magicAwake())
      // By night nobody walks through the dark: Merlin brings them in.
      const dark = (bot.isNight() || bot.duskFallen()) && !bot.buildsByMagic()
      if ((far > HOME_WALK || trip.walks >= 2 || dark || busy) && merlin) {
        this.homeTrips.set(bot.cfg.name, { at: now, walks: 0 })
        this.log.info(`${merlin.cfg.name} sends ${bot.cfg.name} home by portal`)
        void merlin.castCommand('portal', {
          target: bot.cfg.name,
          requestedBy: merlin.cfg.name,
          args: { place: 'home' },
        })
      } else if (!merlin && !HOUSEHOLD && (far > HOME_WALK || trip.walks >= 2 || dark || busy)) {
        // The army has no Merlin: the household's brings the soldier home (woken far away).
        this.homeTrips.set(bot.cfg.name, { at: now, walks: 0 })
        this.log.info(`${bot.cfg.name} asks the household's Merlin for a portal home`)
        this.board.askPortal(bot.cfg.name, now)
      } else if (far <= HOME_WALK && !busy) {
        this.homeTrips.set(bot.cfg.name, { at: now, walks: trip.walks + 1 })
        bot.goTo(home, 'home')
      }
    }
  }

  /** Portals the army asked for that Merlin has seen to: soldier -> when asked. */
  private readonly portalsDone = new Map<string, number>()

  /** The household's Merlin brings home the soldiers who asked (the army has no Merlin). */
  private watchPortals(): void {
    const merlin = this.bots.find((b) => b.magicAwake())
    if (!merlin || !this.household.home) return
    const now = Date.now()
    for (const [name, { at, place }] of Object.entries(this.board.portals())) {
      if (now - at > PORTAL_ASK_MS || at <= (this.portalsDone.get(name) ?? 0)) continue
      this.portalsDone.set(name, at)
      if (!merlin.isOnline(name) || (place === 'home' && this.homeOverrun(merlin))) continue
      this.log.info(`${merlin.cfg.name} sends ${name} of the army to ${place} by portal`)
      this.placesCache = undefined
      void merlin.castCommand('portal', {
        target: name,
        requestedBy: merlin.cfg.name,
        args: { place },
      })
    }
  }

  private lastBedRound = 0
  private tappingBed = false
  /** When each courtier may try a bed again (a tap that did not take waits a while). */
  private readonly bedTried = new Map<string, number>()

  /**
   * Every courtier respawns at a bed at home: the server says where each one respawns, and one
   * whose respawn point is gone (a bed broken, moved, or never tapped) taps a bed, one a round.
   * Without it the dead wake at the world spawn, far off in the dark, and die there again.
   */
  private keepBeds(): void {
    const home = this.household.home
    const now = Date.now()
    if (!home || this.tappingBed || now - this.lastBedRound < BED_ROUND_MS) return
    this.lastBedRound = now
    const homeless = this.bots.find((b) => {
      if (!b.position() || !b.isFree() || (this.bedTried.get(b.cfg.name) ?? 0) > now) return false
      // By day only: a bed tapped at night is lain in, and one sleeper skips the night here.
      if (b.isNight()) return false
      const atHome = b.spawnsAtHome(home)
      // The server has not said: the court's own record (one tap after a start).
      return atHome === undefined ? !this.household.spawnOf(b.cfg.name) : !atHome
    })
    if (!homeless || this.homeOverrun(homeless)) return
    this.tappingBed = true
    this.bedTried.set(homeless.cfg.name, now + BED_RETRY_MS)
    void homeless
      .setSpawnAtBed()
      .then((bed) => {
        if (bed) this.household.setSpawn(homeless.cfg.name, bed)
      })
      .finally(() => (this.tappingBed = false))
  }

  /** Creepers (and TNT) gone off near home lately: what they blew away is damage. */
  private blasts: Array<{ at: number; p: Point }> = []

  private noteBlast(p: Point): void {
    const home = this.household.home
    if (!home || Math.hypot(p.x - home.x, p.z - home.z) > ESTATE_BLAST_REACH) return
    const now = Date.now()
    // Every bot near hears the same blast: once.
    if (this.blasts.some((b) => now - b.at < 2_000 && Math.hypot(b.p.x - p.x, b.p.z - p.z) < 2))
      return
    this.blasts = [...this.blasts.filter((b) => now - b.at < BLAST_MEMORY_MS), { at: now, p }]
    this.log.info(`a blast at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`)
  }

  /** A block here was blown away by a blast lately (damage, even where a royal was). */
  private blownAway(x: number, y: number, z: number): boolean {
    return this.blasts.some(
      (b) => Math.hypot(b.p.x - x - 0.5, b.p.y - y - 0.5, b.p.z - z - 0.5) <= BLAST_RADIUS
    )
  }

  private lastHousekeeping = 0
  private lastMagicRequest = 0
  /** Merlin's magic (in the household's mind). */
  private magic?: Magic
  /** The army's report and Merlin's blessing, between the two minds of this world. */
  private readonly board = new ArmyBoard(path.resolve(STATE_DIR))
  private lastArmyRound = 0
  /** The patrol on the round now, and when each soldier last walked it. */
  private shift?: { until: number; soldiers: string[] }
  private readonly walked = new Map<string, number>()
  /** When Sarge last asked the King for the blessing (once in BLESS_ASK_MS). */
  private blessAsked = 0
  private blessing = false
  /** Where the court is (in which world), shared with the court of the other world. */
  private readonly presence?: Presence
  /** Bots of this court that are in the other world now. */
  private readonly away = new Set<Bot>()
  private moving = false
  /** The King called the court here: Merlin gathers them to him once they have come. */
  private summoned?: { by: string; at: number; merlin: Bot }
  /** What the Castellan last asked the King for, and when (once in ASK_MS: he does not nag). */
  private askedKing: { at: number; wants: MagicWant[] } = { at: 0, wants: [] }
  /** Work that came to nothing lately, and until when it rests (see steward.ts `resting`). */
  private readonly resting = new Map<string, number>()
  /** Work someone is doing right now: nobody else is sent to do it too. */
  private readonly underway = new Set<string>()

  /** The court's work, in the log ("housekeeping: …", "the army: …") and in its history. */
  private work(prefix: string, text: string): void {
    this.log.info(`${prefix}: ${text}`)
    const actor = this.cfg.bots.find((b) => text.startsWith(`${b.name} `))?.name
    record({ kind: 'work', text, ...(actor ? { actor } : {}) })
  }

  /**
   * The court's history of what it heard: whispers by the courtier whispered to, public lines and
   * the server's notices by the household (every mind of a world hears them), and each courtier's
   * own lines by that courtier (Bot.chat), so every line is written once.
   */
  private heard(bot: Bot, event: ChatEvent): void {
    // The war game keeps count of the dead on both sides (every bot hears it; counted once).
    if (this.war && event.kind === 'system' && event.notice?.key.startsWith('death.')) {
      const { key, params } = event.notice
      const killer = /^death\.attack\.(player|mob|arrow|trident|thrown|indirectMagic)/.test(key)
        ? params[1]
        : undefined
      this.war.death(params[0] ?? '', killer, key)
    }
    if (event.kind === 'whisper')
      return record({
        kind: 'chat',
        actor: event.from,
        target: bot.cfg.name,
        text: event.message,
        data: { whisper: true },
      })
    if (!HOUSEHOLD) return
    const courtier = (name: string | undefined) => this.cfg.bots.some((b) => b.name === name)
    if (event.kind === 'system') {
      // The courtiers' own coming and going is in their status, not a line each at every restart.
      if (event.notice?.key.startsWith('multiplayer.player.') && courtier(event.notice.params[0]))
        return
      // Nor what befalls the players the court ignores (the war game's sides in the family's
      // world: dozens of deaths a round would fill the history).
      if (event.notice && IGNORED.has((event.notice.params[0] ?? '').toLowerCase())) return
      return record({
        kind: 'notice',
        text: event.message,
        ...(event.notice ? { data: { key: event.notice.key } } : {}),
      })
    }
    if (courtier(event.from)) return
    record({ kind: 'chat', actor: event.from, text: event.message })
  }

  /** Mark work as underway till it ends, then rest it if it came to nothing. */
  private doing(kind: string, work: Promise<boolean>): void {
    this.underway.add(kind)
    void work
      .then((ok) => this.rest(kind, ok))
      .catch(() => this.rest(kind, false))
      .finally(() => this.underway.delete(kind))
  }

  /** Rest a kind of work for a while after it came to nothing. */
  private rest(kind: string, ok: boolean): void {
    if (ok) this.resting.delete(kind)
    else {
      this.resting.set(kind, Date.now() + REST_MS)
      this.work('housekeeping', `${kind} came to nothing; it rests a while`)
    }
  }

  /**
   * The Castellan keeps house (survival): every minute he takes stock of what the court needs
   * (see steward.ts) and sees to it: builders for the hall, errands for wood, and Merlin's magic
   * for what cannot be had by hand, asking the royal family instead when one is near.
   */
  private async keepHouse(): Promise<void> {
    const home = this.household.home
    if (!home || Date.now() - this.lastHousekeeping < HOUSEKEEPING_MS) return
    const castellan = this.castellan()
    const eyes = this.bots.find((b) => {
      const p = b.position()
      return p && !b.buildsByMagic() && Math.hypot(p.x - home.x, p.z - home.z) < 32
    })
    if (!castellan || castellan.buildsByMagic() || !eyes) return
    this.lastHousekeeping = Date.now()
    const names = (x: number, y: number, z: number) => eyes.nameAt(x, y, z)
    const surveyed = surveyHall(names, home, this.household.hall)
    // Whole: remember it, so damage later (endermen, creepers) can be measured against it.
    if (typeof surveyed !== 'string') this.household.setHall(surveyed)
    // In a castle (doorways three high, rooms opening into rooms): the room the home is in. Its
    // walls, roof, doors and light are the estate's work; its furniture the hall's.
    const room = typeof surveyed === 'string' && !this.household.hall ? this.estateRoom : undefined
    const hall = typeof surveyed === 'string' ? (this.household.hall ?? room) : surveyed
    // A home found finished (the King's palace): the same, though its walls close a hall.
    const finished = this.estate.finished(home)
    if (!hall) return void this.log.info(`housekeeping: cannot see the hall (${surveyed})`)
    /** Furniture of the estate this near home (the King's own furnace, a crafting table). */
    const nearHome = (kind: string, reach: number) =>
      (this.estateFurniture[kind] ?? []).some(
        ([x, , z]) => Math.hypot(x - home.x, z - home.z) <= reach
      )
    const merlin = this.bots.find((b) => b.cfg.magic)
    const staff = this.bots.filter(
      (b) => b.cfg.reportsTo?.toLowerCase() === castellan.cfg.name.toLowerCase() && !b.cfg.magic
    )
    const freeBuilder = staff.find((b) => b.cfg.canBuild && b.isFree() && !b.buildsByMagic())
    const carrying = (items: RegExp) =>
      staff.find((b) => b.cfg.canBuild && b.isFree() && b.carries(items) > 0)?.cfg.name
    let beds = 0
    for (const [x, z] of hall.inside) if (/bed$/.test(names(x, hall.floorY, z) ?? '')) beds++
    // The storehouse chest still standing (a creeper may have taken it, and all in it).
    const chest = this.household.storehouse
    const storehouseThere =
      chest !== undefined &&
      /^(chest|trapped_chest|barrel)$/.test(names(chest.x, chest.y, chest.z) ?? '')
    if (chest && !storehouseThere && names(chest.x, chest.y, chest.z) !== undefined)
      this.household.noteStock({})
    // A soldier opened the storehouse since (a hunt's meat, a mine's ore put in): his account.
    const seen = this.board.stock()
    if (storehouseThere && seen && seen.at > (this.household.stock.at ?? 0))
      this.household.noteStock(seen.items, seen.at)
    const stock = this.household.stock.items
    const sum = (re: RegExp) =>
      Object.entries(stock)
        .filter(([n]) => re.test(n))
        .reduce((total, [, n]) => total + n, 0)
    const seedsHad =
      sum(/^wheat_seeds$/) + this.bots.reduce((n, b) => n + b.carries(/^wheat_seeds$/), 0)
    // Only the King is asked before Merlin's magic (his wish, 2026-10-31).
    const king = this.king()
    const kingAt = king
      ? this.bots.map((b) => b.playerPosition(king.player)).find((p) => p !== undefined)
      : undefined
    const near = (b: Bot | undefined) => {
      const p = b?.position()
      return (
        p !== undefined && kingAt !== undefined && Math.hypot(kingAt.x - p.x, kingAt.z - p.z) < 32
      )
    }
    // Water to fish in, looked for once in an hour (fishing needs a rod, and Merlin conjures one
    // only once the court knows of water: without this nobody ever looked).
    if (this.household.waterNearHome() === undefined) {
      const spot = eyes.findFishingSpot()
      if (spot) {
        this.household.setFishing(spot)
        this.work('housekeeping', `water to fish in at ${spot.water.join(',')}`)
      } else this.household.noteNoWater()
    }
    const state: CourtState = {
      kingNear: near(castellan) || near(merlin),
      merlinAwake: merlin?.magicAwake() ?? false,
      magicLeft: merlin?.magicLeft() ?? 0,
      guardsUnarmed: this.bots
        .filter((b) => b.isGuard() && b.position() && b.carries(/_(sword|axe)$/) === 0)
        .map((b) => b.cfg.name),
      courtiers: this.bots.length,
      // A bed is two blocks.
      bedsInHall: Math.floor(beds / 2),
      freeBuilder: freeBuilder?.cfg.name,
      freeBuilders: staff
        .filter((b) => b.cfg.canBuild && b.isFree() && !b.buildsByMagic())
        .map((b) => b.cfg.name),
      freeHands: staff.filter((b) => b.isFree() && !b.buildsByMagic()).map((b) => b.cfg.name),
      guards: staff.filter((b) => b.isGuard()).map((b) => b.cfg.name),
      builderWithBeds: carrying(/^bed$/),
      builderWithCoal: carrying(/^(coal|charcoal)$/),
      hall:
        room || finished
          ? {
              roof: 0,
              door: 0,
              light: 0,
              repair: 0,
              earth: 0,
              table: tableCells(hall, names).length === 0 || nearHome('crafting_table', 24),
            }
          : {
              roof: roofCells(hall, names).length,
              door: doorCells(hall, names).length,
              light: lightCells(hall, names).length,
              repair: this.household.hall ? repairCells(this.household.hall, names).length : 0,
              earth: reinforceCells(hall, names).length,
              table: tableCells(hall, names).length === 0,
            },
      storeHasCoal: sum(/^(coal|charcoal)$/) > 0,
      withoutFood: this.bots
        .filter((b) => b.position() && b.carries(FOOD_ITEM) === 0)
        .map((b) => b.cfg.name),
      foodInStore: sum(FOOD_ITEM) - sum(RAW),
      rawInStore: sum(RAW),
      // (The cook's furnace is any within 16 blocks of home: the estate's count.)
      furnace:
        hall.inside.some(([x, z]) => /furnace$/.test(names(x, hall.floorY, z) ?? '')) ||
        nearHome('furnace', 16),
      builderWithFurnace: carrying(/^furnace$/),
      farm: {
        exists: Boolean(this.household.farm),
        work: this.farmWork(names, seedsHad, sum(/^wheat$/)),
      },
      cobblestone: sum(/^(cobblestone|cobbled_deepslate)$/),
      stone: sum(/^(cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|stone)$/),
      // A mine worked out (or flooded, or lost) is followed by a new one: the court can always
      // mine, unless there is no mine and no place for one was found.
      mineEnded: !this.household.mine && (this.resting.get('mine') ?? 0) > Date.now(),
      seeds: seedsHad,
      grove: this.groveWork(names),
      woolInStore: sum(/_wool$/),
      weak: this.bots.filter((b) => b.weak()).map((b) => b.cfg.name),
      oreInStore: sum(/^(raw_iron|raw_copper|raw_gold|iron_ore|copper_ore|gold_ore)$/),
      ironInStore: sum(/^iron_ingot$/),
      guardsToOutfit: staff
        .filter((b) => b.isGuard() && b.position())
        .filter((b) => {
          const want = b.outfitWanted(stock)
          return want.sword || want.armour.length > 0
        })
        .map((b) => b.cfg.name),
      fishing: {
        rod:
          sum(/^fishing_rod$/) > 0 ||
          this.bots.some((b) => b.isFree() && b.carries(/^fishing_rod$/) > 0),
        string: sum(/^string$/),
        water: this.household.waterNearHome(),
      },
      // Saplings to hand: the storehouse's, and those a free courtier carries.
      saplings:
        sum(/_sapling$/) +
        this.bots.filter((b) => b.isFree()).reduce((n, b) => n + b.carries(/_sapling$/), 0),
      withSaplings: staff.find((b) => b.isFree() && !b.buildsByMagic() && b.carries(/_sapling$/))
        ?.cfg.name,
      // Guards first: they carry swords. Then anyone of the staff.
      freeHunter: (
        staff.find((b) => b.isGuard() && b.isFree() && !b.buildsByMagic()) ??
        staff.find((b) => b.isFree() && !b.buildsByMagic())
      )?.cfg.name,
      woodInStore: sum(/_log$/) + Math.floor(sum(/_planks$/) / 4),
      freeHand: staff.find((b) => b.isFree() && !b.buildsByMagic())?.cfg.name,
      storehouse: storehouseThere,
      // Blown up, or left behind when the court moved: the court makes itself a new chest.
      storehouseLost: !storehouseThere,
      formerStore: Boolean(this.household.formerStore),
      estate: this.estateWork,
      // No work outdoors begins after mid-afternoon or before the night's monsters burn off.
      night: !castellan.outdoorTime(),
      resting: [...this.resting].filter(([, until]) => until > Date.now()).map(([kind]) => kind),
      underway: [...this.underway],
      basics: true,
      waterField: Boolean(
        this.household.farm &&
        !this.household.farm.watered &&
        this.household.fishing &&
        (sum(/^(bucket|water_bucket)$/) > 0 ||
          sum(/^iron_ingot$/) >= IRON_FOR_BUCKET ||
          this.bots.some((b) => b.isFree() && b.carries(/^(bucket|water_bucket)$/) > 0))
      ),
    }
    const actions = plan(state)
    this.log.debug(`housekeeping: ${JSON.stringify(state)} -> ${JSON.stringify(actions)}`)
    for (const action of actions) {
      await this.carryOutHousekeeping(castellan, merlin, action)
      // The next hall job goes to the next builder: let this one get busy first.
      if (action.kind === 'hallwork') await sleep(500)
    }
  }

  /**
   * What the field wants now: squares to harvest or till, to plant (only with seeds to plant),
   * and wheat in the storehouse to bake.
   */
  private farmWork(
    names: (x: number, y: number, z: number) => string | undefined,
    seeds: number,
    wheat: number
  ): number {
    const farm = this.household.farm
    if (!farm) return 0
    const eyes = this.bots.find((b) => {
      const p = b.position()
      return p && Math.hypot(p.x - farm.cells[0][0], p.z - farm.cells[0][1]) < 48
    })
    let work = 0
    for (const [x, z] of farm.cells) {
      const growth = eyes?.blockProperty(x, farm.y + 1, z, 'growth')
      const need = farmNeed(names(x, farm.y, z), names(x, farm.y + 1, z), Number(growth ?? 0))
      // Farmland without seed in it dries back to dirt: till only with seed to sow.
      if (need === 'harvest' || need === 'fill') work++
      else if ((need === 'till' || need === 'plant') && seeds > 0) work++
    }
    // Seeds to find in the grass for the next plot, while the field may still grow.
    const growing = farm.cells.length < MAX_FIELD && seeds < farm.cells.length + PLOT_SEEDS
    return work + (wheat >= 3 ? 1 : 0) + (growing ? 1 : 0)
  }

  /** The grove: trees grown to fell, bare spots to plant (where the court can see them). */
  private groveWork(names: (x: number, y: number, z: number) => string | undefined): {
    exists: boolean
    fell: number
    plant: number
  } {
    const grove = this.household.grove
    const work = { exists: Boolean(grove), fell: 0, plant: 0 }
    for (const [x, y, z] of grove?.spots ?? []) {
      const need = groveNeed(names(x, y, z), names(x, y + 1, z))
      if (need === 'fell') work.fell++
      else if (need === 'plant') work.plant++
    }
    return work
  }

  private async carryOutHousekeeping(
    castellan: Bot,
    merlin: Bot | undefined,
    action: StewardAction
  ): Promise<void> {
    const by = (name?: string) => this.bots.find((b) => b.cfg.name === name)
    switch (action.kind) {
      case 'hallwork': {
        const builder = by(action.by)
        this.work(
          'housekeeping',
          `${action.work} for the hall${builder ? ` by ${builder.cfg.name}` : ''}`
        )
        if (builder)
          this.doing(
            `hallwork:${action.work}`,
            builder.startHallWork(action.work, castellan.cfg.name)
          )
        else
          void this.sendToHall(
            castellan,
            { work: action.work, requestedBy: castellan.cfg.name },
            true
          )
        return
      }
      case 'hunt': {
        const hunter = by(action.by)
        if (!hunter) return
        this.work('housekeeping', `${hunter.cfg.name} goes hunting for the court's food`)
        void hunter.startHunt(action.animals).then((meat) => this.rest('hunt', meat > 0))
        return
      }
      case 'mine': {
        const miner = by(action.by)
        if (!miner) return
        this.work('housekeeping', `${miner.cfg.name} goes down the mine for stone`)
        this.doing(
          'mine',
          miner.startMining(action.want).then((got) => got > 0)
        )
        return
      }
      case 'arm': {
        const guard = by(action.by)
        if (!guard) return
        this.work('housekeeping', `${guard.cfg.name} arms himself`)
        this.doing('arm', guard.startArming())
        return
      }
      case 'smelt': {
        const smith = by(action.by)
        if (!smith) return
        this.work('housekeeping', `${smith.cfg.name} smelts the storehouse's ore`)
        this.doing(
          'smelt',
          smith.startSmelting().then((n) => n > 0)
        )
        return
      }
      case 'charcoal': {
        const maker = by(action.by)
        if (!maker) return
        this.work('housekeeping', `${maker.cfg.name} makes charcoal for torches`)
        this.doing(
          'charcoal',
          maker.startCharcoal().then((n) => n > 0)
        )
        return
      }
      case 'farm': {
        const farmer = by(action.by)
        if (!farmer) return
        this.work('housekeeping', `${farmer.cfg.name} tends the wheat field`)
        this.doing('farm', farmer.startFarming())
        return
      }
      case 'water': {
        const carrier = by(action.by)
        if (!carrier) return
        this.work('housekeeping', `${carrier.cfg.name} fetches water for the field`)
        this.doing('water', carrier.startWatering())
        return
      }
      case 'fish': {
        const fisher = by(action.by)
        if (!fisher) return
        this.work('housekeeping', `${fisher.cfg.name} goes fishing for the court's food`)
        this.doing(
          'fish',
          fisher.startFishing().then((n) => n > 0)
        )
        return
      }
      case 'forest': {
        const forester = by(action.by)
        if (!forester) return
        this.work('housekeeping', `${forester.cfg.name} tends the grove`)
        this.doing('forest', forester.startForestry())
        return
      }
      case 'estate': {
        const builder = by(action.by)
        if (!builder) return
        this.work('housekeeping', `${builder.cfg.name} sees to the estate: ${action.work}`)
        const work = builder.startEstateWork(action.work, castellan.cfg.name)
        this.doing(`estate:${action.work}`, work)
        // Surveyed again afterwards: what it still wants.
        void work.finally(() => (this.lastEstate = 0))
        return
      }
      case 'move': {
        const mover = by(action.by)
        if (!mover) return
        this.work('housekeeping', `${mover.cfg.name} carries the old storehouse over`)
        this.doing(
          'move',
          mover.startMovingStores().then((n) => n > 0)
        )
        return
      }
      case 'cook': {
        const cook = by(action.by)
        if (!cook) return
        this.work('housekeeping', `${cook.cfg.name} cooks the meat in the storehouse`)
        this.doing(
          'cook',
          cook.startCooking().then((n) => n > 0)
        )
        return
      }
      case 'errand': {
        const hand = by(action.by)
        this.work(
          'housekeeping',
          `${hand ? `${hand.cfg.name} fetches ` : ''}${action.count} ${action.material} for the storehouse`
        )
        if (hand) {
          // One out for it at a time (a second would go through the same woods).
          this.doing(
            action.material,
            hand
              .startGather(action.material, action.count, castellan.cfg.name, true)
              .then((got) => got > 0)
          )
          return
        }
        void this.sendOnErrand(castellan, {
          material: action.material,
          count: action.count,
          requestedBy: castellan.cfg.name,
          from: castellan.cfg.name,
          toStore: true,
        })
        return
      }
      case 'ask': {
        if (Date.now() - this.askedKing.at < ASK_MS) return
        this.askedKing = { at: Date.now(), wants: action.wants }
        this.work('housekeeping', `asking the King for ${action.what}`)
        await castellan.speak(
          `The court needs ${action.what}, which only Merlin's magic can provide just now. Ask ` +
            'the King, politely and in one short sentence, whether Merlin may conjure it.',
          `Your Majesty, might Merlin conjure ${action.what}?`
        )
        return
      }
      case 'magic': {
        if (!merlin || Date.now() - this.lastMagicRequest < MAGIC_REQUEST_MS) return
        this.lastMagicRequest = Date.now()
        await this.conjureFor(castellan, merlin, action)
      }
    }
  }

  /** The army's leader: the soldier whom the rest of the army reports to (Sarge). */
  private sarge(): Bot | undefined {
    return this.bots.find(
      (b) => b.cfg.division === 'army' && this.bots.some((s) => s.cfg.reportsTo === b.cfg.name)
    )
  }

  /**
   * The army keeps itself (its own mind): every minute it tells the household's mind what each
   * soldier wears and carries, arms a soldier without a sword from the storehouse, and Sarge asks
   * the King, when he is near and the army lacks arms, to have Merlin bless it.
   */
  private async keepArmy(): Promise<void> {
    if (Date.now() - this.lastArmyRound < ARMY_ROUND_MS) return
    this.lastArmyRound = Date.now()
    const sarge = this.sarge()
    const soldiers: Record<string, Gear> = {}
    for (const b of this.bots) {
      const gear = b.gear()
      if (gear) soldiers[b.cfg.name] = gear
    }
    const leader = sarge?.cfg.name ?? ''
    const old = this.board.report()
    this.board.writeReport({ at: Date.now(), leader, soldiers, request: old?.request })
    // A sword from the storehouse for one soldier without (the household's stock, as last seen).
    const stock = this.household.stock.items
    const canArm =
      this.household.storehouse &&
      ((stock.cobblestone ?? 0) >= 2 ||
        Object.entries(stock).some(([n, k]) => /_(log|planks)$/.test(n) && k > 0))
    const unarmed = this.bots.find(
      (b) => soldiers[b.cfg.name] && !soldiers[b.cfg.name].sword && b.isFree()
    )
    // Iron or copper in the storehouse (the mines' ore, smelted): armour, piece by piece.
    const toOutfit = this.bots.find((b) => {
      if (!soldiers[b.cfg.name] || !b.isFree()) return false
      const want = b.outfitWanted(stock)
      return want.armour.length > 0 || want.swordMetal !== undefined
    })
    const armer = (canArm ? unarmed : undefined) ?? toOutfit
    if (armer && !this.underway.has('arm') && (this.resting.get('arm') ?? 0) < Date.now()) {
      this.work('the army', `${armer.cfg.name} arms himself from the storehouse`)
      this.doing('arm', armer.startArming())
    }
    this.patrolShift(sarge, soldiers)
    this.armyDuties(sarge, soldiers)
    // Sarge asks the King for the blessing: the army lacks arms, the King is near, not blessed today.
    const king = this.king()
    const blessed = this.board.blessing()
    if (
      !sarge ||
      !king ||
      !wantsBlessing(soldiers, leader) ||
      (blessed && Date.now() - blessed.at < BLESSING_MS) ||
      Date.now() - this.blessAsked < BLESS_ASK_MS
    )
      return
    const kingAt = sarge.playerPosition(king.player)
    const p = sarge.position()
    if (!kingAt || !p || Math.hypot(kingAt.x - p.x, kingAt.z - p.z) > 32) return
    this.blessAsked = Date.now()
    this.log.info('the army: Sarge asks the King for the blessing')
    await sarge.speak(
      'Some of your soldiers have no proper armour, sword or shield. Ask the King, in one short, ' +
        'brisk sentence, whether he would have Merlin bless the army.',
      'Your Majesty, would you have Merlin bless the army?'
    )
  }

  /**
   * The army's patrols: a shift of up to PATROL_SIZE soldiers walks a round about home (round
   * the estate's buildings when there are any), spread along it, for SHIFT_MS; then the next
   * shift, those who walked least first. Only soldiers free of orders, escort and errands, armed,
   * and not hurt or hungry; by night only those in armour. Sarge commands and stays home.
   */
  private patrolShift(sarge: Bot | undefined, soldiers: Record<string, Gear>): void {
    const home = this.household.home
    const now = Date.now()
    if (!home || (this.shift && now < this.shift.until)) return
    const night = sarge?.isNight() ?? false
    const fit = this.bots
      .filter((b) => b !== sarge && b.isGuard() && b.isFree() && !b.weak())
      .filter((b) => soldiers[b.cfg.name]?.sword && (!night || soldiers[b.cfg.name]?.chest))
      .sort((a, b) => (this.walked.get(a.cfg.name) ?? 0) - (this.walked.get(b.cfg.name) ?? 0))
      .slice(0, PATROL_SIZE)
    this.shift = undefined
    if (!fit.length) return
    const route = this.patrolRoute(fit[0], home)
    if (route.length < 3) return
    const until = now + SHIFT_MS
    this.shift = { until, soldiers: fit.map((b) => b.cfg.name) }
    this.work(
      'the army',
      `${fit.map((b) => b.cfg.name).join(', ')} patrol round home (${route.length} points)`
    )
    fit.forEach((b, k) => {
      this.walked.set(b.cfg.name, now)
      void b.startPatrol(route, Math.floor((k * route.length) / fit.length), until)
    })
  }

  /**
   * Off the round, by day, a soldier is not idle (the King's wish, 2026-10-31): food first, a
   * hunt when the storehouse is short of meals (soldiers carry swords), else the army's own mine
   * for iron and copper (its armour) and coal (torches). One at each at a time; Sarge commands.
   */
  private armyDuties(sarge: Bot | undefined, soldiers: Record<string, Gear>): void {
    if (!this.household.home || !this.household.storehouse) return
    if (!(sarge ?? this.bots[0])?.outdoorTime()) return
    const onRound = new Set(this.shift?.soldiers ?? [])
    const free = this.bots.filter(
      (b) =>
        b !== sarge &&
        b.isFree() &&
        !b.weak() &&
        !onRound.has(b.cfg.name) &&
        Boolean(soldiers[b.cfg.name]?.sword)
    )
    const now = Date.now()
    const rests = (kind: string) => this.underway.has(kind) || (this.resting.get(kind) ?? 0) > now
    const stock = this.household.stock.items
    const count = (re: RegExp) =>
      Object.entries(stock)
        .filter(([n]) => re.test(n))
        .reduce((total, [, n]) => total + n, 0)
    if (count(FOOD_ITEM) < ARMY_FOOD && !rests('hunt')) {
      const hunter = free.shift()
      if (hunter) {
        this.work('the army', `${hunter.cfg.name} goes hunting for the court's food`)
        this.doing(
          'hunt',
          hunter.startHunt(3).then((meat) => meat > 0)
        )
      }
    }
    if (!rests('mine')) {
      const miner = free.shift()
      if (miner) {
        this.work('the army', `${miner.cfg.name} goes down the army's mine`)
        this.doing(
          'mine',
          miner.startMining(32).then((got) => got > 0)
        )
      }
    }
  }

  /**
   * The round: points on a ring PATROL_MARGIN blocks outside the estate's buildings and the
   * hall (or PATROL_RADIUS round home without them), each on ground one can stand on.
   */
  private patrolRoute(eyes: Bot, home: Point): Point[] {
    const areas = [...this.household.estate]
    const hall = this.household.hall
    if (hall) {
      const xs = [...hall.ring, ...hall.inside].map(([x]) => x)
      const zs = [...hall.ring, ...hall.inside].map(([, z]) => z)
      const x0 = Math.min(...xs)
      const z0 = Math.min(...zs)
      areas.push({ x: x0, z: z0, width: Math.max(...xs) - x0 + 1, depth: Math.max(...zs) - z0 + 1 })
    }
    const [x0, z0, x1, z1] = areas.length
      ? [
          Math.min(...areas.map((a) => a.x)) - PATROL_MARGIN,
          Math.min(...areas.map((a) => a.z)) - PATROL_MARGIN,
          Math.max(...areas.map((a) => a.x + a.width - 1)) + PATROL_MARGIN,
          Math.max(...areas.map((a) => a.z + a.depth - 1)) + PATROL_MARGIN,
        ]
      : [
          home.x - PATROL_RADIUS,
          home.z - PATROL_RADIUS,
          home.x + PATROL_RADIUS,
          home.z + PATROL_RADIUS,
        ]
    const mx = Math.round((x0 + x1) / 2)
    const mz = Math.round((z0 + z1) / 2)
    const corners: Array<[number, number]> = [
      [x0, z0],
      [mx, z0],
      [x1, z0],
      [x1, mz],
      [x1, z1],
      [mx, z1],
      [x0, z1],
      [x0, mz],
    ]
    const PASSABLE =
      /^(air|cave_air|short_grass|tall_grass|fern|large_fern|[a-z_]*flower|[a-z_]*tulip|dandelion|poppy|snow_layer|torch)$/
    const SOLID_NOT = /^(air|cave_air|water|flowing_water|lava|flowing_lava|[a-z_]*leaves|fire)$/
    const route: Point[] = []
    for (const [x, z] of corners)
      for (let y = home.y + 8; y >= home.y - 8; y--) {
        const below = eyes.nameAt(x, y - 1, z)
        if (below === undefined) break
        if (
          !SOLID_NOT.test(below) &&
          PASSABLE.test(eyes.nameAt(x, y, z) ?? '') &&
          PASSABLE.test(eyes.nameAt(x, y + 1, z) ?? '')
        ) {
          route.push({ x, y, z })
          break
        }
      }
    return route
  }

  /** The King answers Sarge's question: on his yes the household's Merlin is asked to bless. */
  private kingBlesses(event: ChatEvent): void {
    if (Date.now() - this.blessAsked > ANSWER_MS) return
    if (event.kind === 'system' || event.from !== this.king()?.player) return
    const answer = confirmation(event.message)
    if (!answer) return
    this.blessAsked = Date.now() - ANSWER_MS - 1
    this.work('the army', `the King says ${answer} to the blessing`)
    if (answer === 'no') return
    const report = this.board.report()
    if (report) this.board.writeReport({ ...report, request: { by: event.from, at: Date.now() } })
  }

  /** Merlin (the household's mind) watches for a blessing the King granted Sarge. */
  private watchBlessing(): void {
    const request = this.board.report()?.request
    const merlin = this.bots.find((b) => b.cfg.magic && b.magicAwake())
    if (!request || !merlin || this.blessing) return
    if (request.at <= (this.board.blessing()?.requestAt ?? 0)) return
    if (Date.now() - request.at > 10 * 60_000) return
    void this.blessArmy(merlin, request.by, request.at)
  }

  /**
   * "Bless the Army", on the King's word: copper armour, a copper sword and a shield for every
   * soldier with nothing better, iron for Sarge, from what the army last reported; once a day,
   * and it fades after a day like all of Merlin's gifts.
   */
  private async blessArmy(merlin: Bot, by: string, requestAt?: number): Promise<void> {
    if (this.blessing) return
    this.blessing = true
    try {
      const address = this.court.find(by)?.address ?? 'Your Majesty'
      const last = this.board.blessing()
      const done = (at: number) => this.board.writeBlessing({ at, by, requestAt })
      if (last && Date.now() - last.at < BLESSING_MS) {
        done(last.at)
        merlin.chat(
          `The army was blessed today, ${address}; the blessing fades by tomorrow, and then I may bless it again.`
        )
        return
      }
      const report = this.board.report()
      if (!report || Date.now() - report.at > 3 * 60_000) {
        merlin.chat(`Alas, ${address}: I cannot see the army just now.`)
        return
      }
      const soldiers = Object.fromEntries(
        Object.entries(report.soldiers).filter(([name]) => merlin.isOnline(name))
      )
      const steps = blessingSteps(soldiers, report.leader)
      if (!steps.length) {
        done(last?.at ?? 0)
        merlin.chat(`Every soldier is armed already, ${address}!`)
        return
      }
      let given = 0
      for (const step of steps) {
        const result = await merlin.command(step.command)
        if (!result.ok) {
          this.work('the blessing', `"${step.command}" refused: ${result.output.join('; ')}`)
          continue
        }
        this.magic?.noteGift(step.to, step.item, [step.undo])
        given++
      }
      done(Date.now())
      const blessed = new Set(steps.map((s) => s.to)).size
      this.work('the blessing', `${given} pieces for ${blessed} soldiers, by ${by}'s word`)
      merlin.chat(
        `Behold, ${address}: the army is blessed! Copper for the soldiers, iron for ${report.leader || 'their sergeant'}.`
      )
    } finally {
      this.blessing = false
    }
  }

  /** The King, the highest rank at court. */
  private king(): CourtMember | undefined {
    const top = Math.max(1, ...this.court.members.map((m) => rankOf(m.role)))
    return this.court.members.find((m) => rankOf(m.role) >= top)
  }

  /** The King answers the Castellan's question: on his yes Merlin conjures what was asked. */
  private kingAnswers(event: ChatEvent): void {
    const asked = this.askedKing
    if (!asked.wants.length || Date.now() - asked.at > ANSWER_MS) return
    if (event.kind === 'system' || event.from !== this.king()?.player) return
    const answer = confirmation(event.message)
    if (!answer) return
    this.askedKing = { at: asked.at, wants: [] }
    this.work(
      'housekeeping',
      `the King says ${answer} to ${asked.wants.map((w) => w.why).join(', ')}`
    )
    const castellan = this.castellan()
    const merlin = this.bots.find((b) => b.cfg.magic)
    if (answer === 'no' || !castellan || !merlin) return
    void (async () => {
      for (const want of asked.wants) await this.conjureFor(castellan, merlin, want)
    })().catch((err) => this.log.warn(`conjuring for the court failed: ${errMsg(err)}`))
  }

  /** The Castellan asks Merlin for something the court needs, and it goes straight to work. */
  private async conjureFor(castellan: Bot, merlin: Bot, action: MagicWant): Promise<void> {
    const by = (name?: string) => this.bots.find((b) => b.cfg.name === name)
    const before = merlin.magicLeft()
    this.work('housekeeping', `${castellan.cfg.name} asks ${merlin.cfg.name} for ${action.why}`)
    await castellan.speak(
      `You ask Merlin, the court wizard, to conjure ${action.why} (${action.count} ` +
        `${action.item.replace(/_/g, ' ')} for ${action.to}). Say it to him in one short, ` +
        'polite sentence.',
      `Merlin, might you conjure ${action.why}?`
    )
    await merlin.castCommand('gift', {
      target: action.to,
      requestedBy: castellan.cfg.name,
      args: { item: action.item, count: action.count },
    })
    const given = before - merlin.magicLeft()
    if (given <= 0) return
    // The very thing and number: a model left to it said "a baked potato" for one bread.
    const what = `${given} ${action.item.replace(/_/g, ' ')}`
    await merlin.speak(
      `At Festaris's request you have just conjured ${what} for ${action.to} (${action.why}). ` +
        `Say so in one short, magical sentence, naming exactly ${what}.`,
      `There! ${what[0].toUpperCase()}${what.slice(1)} for ${action.to}.`
    )
    // The beds or coal go straight to work.
    const then = action.then
    const worker = by(action.to)
    if (then && worker)
      setTimeout(() => {
        if (then === 'farm') this.doing('farm', worker.startFarming())
        else if (then === 'fish')
          this.doing(
            'fish',
            worker.startFishing().then((n) => n > 0)
          )
        else if (then === 'forest') this.doing('forest', worker.startForestry())
        else if (then === 'estate-light')
          this.doing('estate:light', worker.startEstateWork('light', castellan.cfg.name))
        else this.doing(`hallwork:${then}`, worker.startHallWork(then, castellan.cfg.name))
      }, 2_000)
  }

  /** The Castellan sets one of his builders to work on the hall: the nearest free one. */
  private async sendToHall(
    from: Bot,
    job: { work: HallWork; requestedBy: string },
    quiet = false
  ): Promise<void> {
    const boss = from.cfg.name.toLowerCase()
    const home = this.household.home
    const distance = (b: Bot) => {
      const p = b.position()
      return p && home ? Math.hypot(p.x - home.x, p.z - home.z) : Infinity
    }
    const builder = this.bots
      .filter((b) => b.cfg.canBuild && !b.cfg.magic && b.cfg.reportsTo?.toLowerCase() === boss)
      .filter((b) => b.isFree() && !b.buildsByMagic())
      .sort((a, b) => distance(a) - distance(b))[0]
    if (!builder) {
      if (quiet) return
      await from.speak(
        `None of your builders is free for the hall just now. Say so kindly in one short sentence.`,
        'Alas, the builders are all busy just now.'
      )
      return
    }
    this.log.info(`${from.cfg.name} sets ${builder.cfg.name} to work on the hall: ${job.work}`)
    await builder.startHallWork(job.work, job.requestedBy)
  }

  /**
   * The Castellan sends one of his staff on a royal's errand: the nearest free one who works by
   * hand (survival). If none is free, he says so.
   */
  private async sendOnErrand(from: Bot, errand: Errand): Promise<void> {
    const boss = from.cfg.name.toLowerCase()
    const near = from.playerPosition(errand.requestedBy) ?? from.position()
    const distance = (b: Bot) => {
      const p = b.position()
      return p && near ? Math.hypot(p.x - near.x, p.z - near.z) : Infinity
    }
    const worker = this.bots
      .filter((b) => b.cfg.reportsTo?.toLowerCase() === boss && !b.cfg.magic)
      .filter((b) => b.isFree() && !b.buildsByMagic())
      .sort((a, b) => distance(a) - distance(b))[0]
    if (!worker) {
      this.log.info(
        `no free hand for ${from.cfg.name}'s errand: ${errand.count} ${errand.material}`
      )
      await from.speak(
        `None of your staff is free to fetch the ${errand.material} just now. Say so kindly in ` +
          'one short sentence, and that it will be done as soon as someone is free.',
        'Alas, everyone is busy just now.'
      )
      return
    }
    this.log.info(
      `${from.cfg.name} sends ${worker.cfg.name} for ${errand.count} ${errand.material}`
    )
    await worker.startGather(errand.material, errand.count, errand.requestedBy, errand.toStore)
  }

  private placesCache?: { at: number; places: Place[] }
  /** The court's home and storehouse (survival). */
  /** The household's own record; the army's mind follows it (read only). */
  private readonly household = new Household(path.resolve(STATE_DIR, 'household.json'), !HOUSEHOLD)
  /** When each bot was last sent home, and how many walks in a row did not get it there. */
  private readonly homeTrips = new Map<string, { at: number; walks: number }>()

  /** Named places of the castles built and being built (for Merlin's portal), cached a while. */
  private places(): Place[] {
    if (!this.placesCache || Date.now() - this.placesCache.at > 10 * 60_000) {
      const works = this.courtWorks()
      const files = [...works.built, ...(works.current ? [works.current] : [])].map((f) =>
        path.resolve(f.replace(/\\/g, '/'))
      )
      this.placesCache = { at: Date.now(), places: placesFromFiles([...new Set(files)]) }
    }
    const places = [...this.placesCache.places]
    // The household's own places, for Merlin's portal: "take us home". Looked at afresh each
    // time: a creeper's crater under the home spot is a trap nobody walks out of.
    const { storehouse, formerStore } = this.household
    const home = this.homeSpot()
    if (home) places.push({ name: 'home', x: home.x + 0.5, y: home.y, z: home.z + 0.5 })
    if (formerStore)
      places.push({
        name: 'the old storehouse',
        x: formerStore.x + 0.5,
        y: formerStore.y + 1,
        z: formerStore.z + 0.5,
      })
    if (storehouse)
      places.push({
        name: 'the storehouse',
        x: storehouse.x + 0.5,
        y: storehouse.y + 1,
        z: storehouse.z + 0.5,
      })
    return places
  }

  /**
   * Where Merlin sets someone down at home: the home spot, or when the floor there is gone (a
   * creeper's crater: everyone portalled into it was stuck at its bottom) the nearest sound
   * floor beside it.
   */
  private homeSpot(): Point | undefined {
    const home = this.household.home
    if (!home) return undefined
    const eyes = this.bots.find((b) => b.nameAt(home.x, home.y - 1, home.z) !== undefined)
    if (!eyes) return home
    const AIR = /^(air|cave_air|short_grass|tall_grass|torch|wall_torch|[a-z_]*_carpet)$/
    const GONE = /^(air|cave_air|water|flowing_water|lava|flowing_lava|fire)$/
    const stand = (x: number, y: number, z: number) => {
      const below = eyes.nameAt(x, y - 1, z)
      return (
        below !== undefined &&
        !GONE.test(below) &&
        AIR.test(eyes.nameAt(x, y, z) ?? '') &&
        AIR.test(eyes.nameAt(x, y + 1, z) ?? '')
      )
    }
    for (let r = 0; r <= 6; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          if (stand(home.x + dx, home.y, home.z + dz))
            return { x: home.x + dx, y: home.y, z: home.z + dz }
        }
    return home
  }

  /** Which designs the court has built and is building, kept in .state/court-works.json. */
  private courtWorks(): CourtWorks {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.resolve(STATE_DIR, 'court-works.json'), 'utf8')
      ) as CourtWorks
      // Written on Windows with backslashes; the court also runs on Linux (Docker on Ava).
      const portable = (f: string) => f.replace(/\\/g, '/')
      return {
        ...state,
        built: (state.built ?? []).map(portable),
        current: state.current && portable(state.current),
      }
    } catch {
      return { built: [] }
    }
  }

  private saveCourtWorks(state: CourtWorks): void {
    fs.mkdirSync(path.resolve(STATE_DIR), { recursive: true })
    fs.writeFileSync(path.resolve(STATE_DIR, 'court-works.json'), JSON.stringify(state, null, 2))
  }

  /** The court's works for the prompts: what is being built, and what was ordered next. */
  private worksLine(): string | undefined {
    const ordered = this.courtWorks().ordered
    const next = ordered
      ? `next, the new ${ordered.what} ${ordered.by} ordered${this.planning ? ', whose plans the master builder is drawing right now' : ''}`
      : this.planning
        ? 'the master builder is drawing the plans for the next castle right now'
        : undefined
    return [this.works?.summary(), next].filter(Boolean).join('; ') || undefined
  }

  /** A royal orders a new palace or castle: it is planned now, or once the crew is free. */
  private async orderWorks(bot: Bot, order: WorksOrder): Promise<void> {
    const member = this.court.find(order.requestedBy)
    const by = member ? `the ${member.title}` : order.requestedBy
    const near =
      order.near ?? this.bots.map((b) => b.playerPosition(order.requestedBy)).find(Boolean)
    if (!near) {
      await bot.speak(
        `You cannot see where ${by} stands, so you do not know where the new ${order.what} should go. ` +
          `Ask ${by} kindly to come where the court can see, or to name the coordinates.`,
        `Where shall it stand? Come where I can see you, or name the place.`
      )
      return
    }
    const y =
      near.y ?? this.bots.map((b) => b.topAt(near.x, near.z)?.y).find((h) => h !== undefined) ?? 80
    const ordered: OrderedWorks = {
      what: order.what,
      requestedBy: order.requestedBy,
      by,
      near: { x: Math.floor(near.x), y: Math.floor(y), z: Math.floor(near.z) },
      at: Date.now(),
    }
    // A newer order replaces one still waiting for its plans.
    const state = this.courtWorks()
    state.ordered = ordered
    this.saveCourtWorks(state)
    this.log.info(
      `${by} orders a new ${order.what} near ${ordered.near.x},${ordered.near.y},${ordered.near.z}`
    )
    if (this.planning || (this.works && !this.works.finished)) {
      await bot.speak(
        `Tell ${by} kindly, in one or two short sentences, that the crew first finishes what it is ` +
          `building now (${this.works?.summary() ?? 'other plans'}), and then begins the new ` +
          `${order.what} at the spot ${by} chose.`,
        `The crew finishes the work in hand first, then the new ${order.what} begins.`
      )
      return
    }
    await this.planNextCastle(ordered)
  }

  /**
   * The court plans its next castle: the bots survey the land they can see, the overlord (a
   * larger model) chooses a site and designs the castle, and the works begin. On its own the
   * court keeps to its build zone; a palace a royal ordered goes up near the spot they chose.
   */
  async planNextCastle(ordered?: OrderedWorks): Promise<void> {
    if (this.planning) return
    this.planning = true
    const foreman = this.foreman()
    try {
      const scout = this.bots.find((b) => b.state.status === 'spawned')
      const zone = ordered ? { center: ordered.near, radius: ORDERED_RADIUS } : this.buildZone()
      // What stands round home already (the King's castle): kept clear, and the overlord is
      // told about it, so it adds what is missing instead of building it all again.
      const home = this.household.home
      const estate = home ? this.estate.of(home) : undefined
      const standing = estate?.buildings.filter((b) => b.rooms.length > 0) ?? []
      const covered = ordered ? [] : coveredNeeds(standing.flatMap((b) => b.rooms))
      if (!ordered && standing.length && covered.length === NEEDED.length) {
        this.log.info('the estate round home has all the court needs: no new castle')
        await foreman?.speak(
          "Tell everyone that the master builder looked at the court's home and found it has " +
            'every room the court needs, so nothing new is built: the court keeps it in repair instead.',
          'Our home has all we need: we keep it in good repair instead of building anew.'
        )
        return
      }
      if (!scout || !zone)
        return this.log.warn('cannot plan a castle: no bot in the world or no build zone')
      await foreman?.speak(
        ordered
          ? `Tell everyone that the master builder and you are now drawing up the plans for the new ${ordered.what} ` +
              `${ordered.by} ordered, at the spot ${ordered.by} chose. Ask them to rest a moment.`
          : 'Tell everyone that the master builder and you are now drawing up the plans for a second castle, ' +
              'which the court will choose and design all by itself. Ask them to rest a moment.',
        ordered
          ? `The master builder and I are drawing up the plans for the new ${ordered.what}. Rest a moment, friends!`
          : 'The master builder and I are drawing up plans for a second castle. Rest a moment, friends!'
      )
      const built = this.courtWorks().built
      const avoid: Rect[] = []
      for (const file of [...built, this.cfg.worksDesign].filter(Boolean) as string[]) {
        try {
          avoid.push((JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as CastleDesign).area)
        } catch {
          // a design that is gone takes no room
        }
      }
      if (this.works) avoid.push(this.works.plan.area)
      for (const b of estate?.buildings ?? [])
        avoid.push({ x: b.x, z: b.z, width: b.width, depth: b.depth })
      // What every bot in the world can see, remembered column by column.
      const known = new Map<string, { y: number; name: string }>()
      const look = () => {
        const r = zone.radius
        for (const b of this.bots.filter((bot) => bot.state.status === 'spawned'))
          for (let x = zone.center.x - r; x <= zone.center.x + r; x++)
            for (let z = zone.center.z - r; z <= zone.center.z + r; z++) {
              const k = `${x},${z}`
              if (known.has(k)) continue
              const t = b.topAt(x, z)
              if (t) known.set(k, t)
            }
      }
      look()
      const topAt = (x: number, z: number) => known.get(`${x},${z}`) ?? null
      let sites = findCastleSites(topAt, zone, { avoid })
      if (sites.length < 3) {
        // Not enough open ground in sight: one of the guards flies a survey over the zone first.
        const flyer = this.bots.find((b) => b.cfg.duty && b.state.status === 'spawned') ?? scout
        const r = Math.round(zone.radius * 0.6)
        const points = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => ({
          x: Math.round(zone.center.x + r * Math.cos((deg * Math.PI) / 180)),
          z: Math.round(zone.center.z + r * Math.sin((deg * Math.PI) / 180)),
        }))
        this.log.info(`only ${sites.length} sites in sight; ${flyer.cfg.name} flies a survey`)
        await flyer.survey(points, zone.center.y + 40, look)
        sites = findCastleSites(topAt, zone, { avoid })
      }
      for (const [i, s] of sites.entries()) this.log.info(`site ${i + 1}: ${JSON.stringify(s)}`)
      if (ordered && sites.length === 0) {
        const state = this.courtWorks()
        state.ordered = undefined
        this.saveCourtWorks(state)
        await foreman?.speak(
          `Tell ${ordered.by} kindly that there is no open ground big enough for a ${ordered.what} near the ` +
            'spot chosen: the court never builds over houses, paths or anything anyone made. Ask for another spot.',
          `Alas, there is no open ground big enough here. Shall we find another spot?`
        )
        return
      }
      const model = process.env.OVERLORD_MODEL ?? 'gemma4:31b'
      const ai = overlordClient(this.bots[0].cfg.ai, model, this.log.child('overlord'))
      const overlord = new Overlord(ai, model, this.log.child('overlord'))
      let example: CastleDesign | undefined
      try {
        example = this.cfg.worksDesign
          ? (JSON.parse(
              fs.readFileSync(path.resolve(this.cfg.worksDesign), 'utf8')
            ) as CastleDesign)
          : undefined
      } catch {
        example = undefined
      }
      const result = await overlord.planCastle({
        sites,
        crew: this.bots
          .filter((b) => b.cfg.works)
          .map((b) => ({ name: b.cfg.name, role: b.cfg.role })),
        example,
        takenNames: [example?.name, this.works?.plan.title].filter(Boolean) as string[],
        ...(standing.length && estate ? { standing: { words: estate.words, covered } } : {}),
        ...(ordered
          ? {
              request: `${capital(ordered.by)} orders a new ${ordered.what}, different from the castles already built.`,
              around: `the spot ${ordered.by} chose`,
            }
          : {}),
      })
      if (!result) {
        await foreman?.speak(
          'Tell everyone kindly that the plans for the second castle are not ready yet and that the court will try again later.',
          'The plans are not ready yet, friends. We shall try again later.'
        )
        return
      }
      const file = path.posix.join(STATE_DIR, 'designs', `${slug(result.design.name)}.json`)
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
      fs.writeFileSync(path.resolve(file), JSON.stringify(result.design, null, 2))
      this.log.info(
        `overlord designed ${result.design.name} (${file}) on site ${JSON.stringify(result.site.area)}: ${result.summary}`
      )
      const state = this.courtWorks()
      const finished = state.current ?? this.cfg.worksDesign
      if (finished && !state.built.includes(finished)) state.built.push(finished)
      state.current = file
      if (ordered) state.ordered = undefined
      this.saveCourtWorks(state)
      await foreman?.speak(
        ordered
          ? `Announce the plan for ${result.design.name}, the new ${ordered.what} ${ordered.by} ordered, which the master builder drew near the spot ${ordered.by} chose: ${result.summary} Call the crew to work.`
          : `Announce the plan for the second castle, ${result.design.name}, which the master builder drew ${result.site.direction} of the castle grounds: ${result.summary} Call the crew back to work.`,
        `Behold the plan for ${result.design.name}! Back to work, all!`
      )
      this.startWorks(file)
    } catch (err) {
      this.log.warn(`planning the next castle failed: ${errMsg(err)}`)
    } finally {
      this.planning = false
    }
  }

  /** Begin (or carry on with) building a castle design with every bot that works. */
  startWorks(file: string): boolean {
    let design: CastleDesign
    try {
      design = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as CastleDesign
    } catch (err) {
      this.log.warn(`cannot read castle design ${file}: ${errMsg(err)}`)
      return false
    }
    const problems = validateDesign(design)
    if (problems.length) {
      this.log.warn(`castle design ${file} has problems:\n  ${problems.join('\n  ')}`)
      return false
    }
    const plan = compileDesign(design)
    clearInterval(this.worksTimer)
    this.milestone = 0
    this.works = new Works(
      plan,
      path.resolve(STATE_DIR, `works-${plan.id}.json`),
      this.log.child('works'),
      (e) => this.onWorksEvent(e)
    )
    const blocks = plan.sections.reduce((n, s) => n + s.cells.length, 0)
    const { done, total } = this.works.progress()
    // Milestones already passed (before a restart) are not announced again.
    this.milestone = Math.floor((done / total) * 4)
    this.log.info(`works: ${plan.title}, ${total} sections (${done} done), ${blocks} blocks`)
    if (this.ready) this.runWorks()
    return true
  }

  private runWorks(): void {
    clearInterval(this.worksTimer)
    this.worksTimer = setInterval(() => {
      // One failing step must not take the court down (a bot still joining once did: the
      // whole process died, and every bot was kept out for a minute as already connected).
      try {
        if (HOUSEHOLD) {
          // The royal family's wishes first, then the castle.
          this.assignCommissions()
          this.works?.tick(this.workers())
        }
        // Whoever is still free afterwards goes home.
        this.sendHome()
        this.keepBeds()
        this.watchCreepers()
        if (HOUSEHOLD) this.noteRoyals()
        if (HOUSEHOLD) this.watchPortals()
      } catch (err) {
        this.log.warn(`the court's round failed: ${errMsg(err)}`)
      }
      if (HOUSEHOLD)
        void this.upkeepEstate()
          .then(() => this.keepHouse())
          .catch((err) => this.log.warn(`housekeeping failed: ${errMsg(err)}`))
      if (!HOUSEHOLD)
        void this.keepArmy().catch((err) =>
          this.log.warn(`the army's round failed: ${errMsg(err)}`)
        )
      if (HOUSEHOLD) this.watchBlessing()
      void this.followCourt().catch((err) =>
        this.log.warn(`following the court failed: ${errMsg(err)}`)
      )
    }, 5_000)
  }

  /** A royal asked a bot for a build: the court writes it down, and it is built or handed on. */
  private commission(bot: Bot, request: CommissionRequest): void {
    const c = this.commissions.add({
      blueprint: request.blueprint,
      title: makeBlueprint(request.blueprint, request.palette).title,
      palette: request.palette,
      requestedBy: request.requestedBy,
      takenBy: bot.cfg.name,
      own: request.own,
      near: request.near && {
        x: Math.floor(request.near.x),
        y: Math.floor(request.near.y),
        z: Math.floor(request.near.z),
      },
    })
    const where = c.near ? `near ${c.near.x},${c.near.y},${c.near.z}` : '(not in sight yet)'
    this.log.info(`${bot.cfg.name} takes ${c.id}: ${c.title} for ${c.requestedBy} ${where}`)
    // Asked of a builder: he builds it at once. Asked of the Castellan: the next free builder does.
    if (c.own) void this.carryOut(c, bot)
    else this.assignCommissions()
  }

  /** Hand each waiting commission to a free builder, the nearest first. */
  private assignCommissions(): void {
    if (!this.ready) return
    for (const c of this.commissions.waiting()) {
      if (!c.near) {
        const seen = this.bots.map((b) => b.playerPosition(c.requestedBy)).find(Boolean)
        if (!seen) continue
        this.commissions.locate(c.id, seen)
      }
      const near = c.near!
      const crew = this.crewFor(c).filter((b) => b.isFree() && b.buildsByMagic())
      const distance = (b: Bot) => {
        const p = b.position()
        return p ? Math.hypot(p.x - near.x, p.z - near.z) : Infinity
      }
      const worker = crew.sort((a, b) => distance(a) - distance(b))[0]
      if (worker) void this.carryOut(c, worker)
    }
  }

  /** Who may build a commission: the builder who took it, or the builders of the one who took it. */
  private crewFor(c: Commission): Bot[] {
    const taker = c.takenBy.toLowerCase()
    if (c.own) return this.bots.filter((b) => b.cfg.name.toLowerCase() === taker)
    return this.bots.filter((b) => b.cfg.canBuild && b.cfg.reportsTo?.toLowerCase() === taker)
  }

  /** A builder raises a commission; one handed on is given out by the one who took it, aloud. */
  private async carryOut(c: Commission, worker: Bot): Promise<void> {
    const name = worker.cfg.name
    this.commissions.start(c.id, name)
    this.log.info(`${name} builds ${c.id}: ${c.title} for ${c.requestedBy}`)
    const member = this.court.find(c.requestedBy)
    const who = member ? `the ${member.title}` : c.requestedBy
    if (!c.own) {
      const boss = this.find(c.takenBy)
      void (async () => {
        await boss?.speak(
          `Tell ${name} to build ${c.title} for ${who} now. Address ${name} by name, in one short sentence.`,
          `${name}, build ${c.title} for ${who}, if you please.`
        )
        await sleep(3_000)
        await worker.speak(
          `${c.takenBy}, whom you report to, just asked you to build ${c.title} for ${who}. ` +
            `Answer ${c.takenBy} in one short sentence that you are on your way.`,
          `At once, Master ${c.takenBy}!`
        )
      })().catch((err) => this.log.warn(`commission talk failed: ${errMsg(err)}`))
    }
    let outcome: BuildOutcome
    try {
      outcome = await worker.startBuild(
        c.blueprint,
        c.palette,
        c.requestedBy,
        c.near ? { at: c.near } : undefined
      )
    } catch (err) {
      this.log.warn(`${name} failed to build ${c.title}: ${errMsg(err)}`)
      outcome = {
        title: c.title,
        requestedBy: c.requestedBy,
        ok: false,
        placed: 0,
        total: 0,
        reason: 'stuck',
      }
    }
    this.commissions.finish(c.id, outcome)
    const now = this.commissions.find(c.id)
    this.log.info(
      `${c.id} (${c.title} for ${c.requestedBy}): ${now?.status}` +
        `${outcome.reason ? ` (${outcome.reason})` : ''}, ${outcome.placed}/${outcome.total} blocks`
    )
  }

  private workers(): Worker[] {
    return this.bots
      .filter((b) => b.cfg.works)
      .map((b) => ({
        name: b.cfg.name,
        available: () => b.canWork(),
        position: () => b.position(),
        work: (job) => b.work(job),
        idle: (spot) => b.rest(spot),
      }))
  }

  /** The Castellan, if he is in the world: he runs the works and does the talking. */
  private foreman(): Bot | undefined {
    return this.bots.find((b) => /castellan/i.test(b.cfg.role) && b.state.status === 'spawned')
  }

  /** Run some work talk unless the court talked a moment ago or a royal is talking. */
  private chatter(talk: () => Promise<void>, force = false): void {
    const now = Date.now()
    const recent =
      now - this.lastChatter < CHATTER_GAP_MS || now - this.lastRoyalLine < ROYAL_QUIET_MS
    if (!force && recent) return
    this.lastChatter = now
    talk().catch((err) => this.log.warn(`work talk failed: ${errMsg(err)}`))
  }

  private onWorksEvent(e: WorksEvent): void {
    const foreman = this.foreman()
    const boss = foreman?.cfg.name
    const title = this.works?.plan.title ?? 'the castle'
    switch (e.kind) {
      case 'begin': {
        const first = this.courtWorks().built.length === 0
        this.chatter(async () => {
          await (foreman ?? this.bots[0])?.speak(
            first
              ? `Announce to everyone that the court now begins building ${e.plan.title} around Merlin's first castle, as the King wished: ` +
                  'a keep with a kitchen, a great hall, a throne room and royal bedchambers, ranges for the guards and staff, stables and towers. ' +
                  'Call every member of the court to lend a hand.'
              : `Announce to everyone that the court now begins building ${e.plan.title}. Call every member of the court to lend a hand.`,
            `Hear me, all! We begin ${e.plan.title} today. Every hand to the work!`
          )
        }, true)
        return
      }
      case 'assign': {
        const worker = this.find(e.worker)
        this.chatter(async () => {
          // The Castellan gives tasks only to his own staff; Merlin picks his part himself.
          if (foreman && worker && worker.cfg.reportsTo === boss) {
            await foreman.speak(
              `Tell ${e.worker} to build ${e.section.title} now. Address ${e.worker} by name.`,
              `${e.worker}, see to ${e.section.title}, if you please.`
            )
            await sleep(3_000)
            await worker.speak(
              `${boss}, the Castellan, just asked you to build ${e.section.title}. Answer ${boss} in one short sentence that you will.`,
              `At once, Master ${boss}!`
            )
          } else if (worker) {
            await worker.speak(
              `Tell the court in one short sentence that you are now building ${e.section.title} yourself.`,
              `I shall see to ${e.section.title} myself.`
            )
          }
        })
        return
      }
      case 'done': {
        if (!e.complete) return
        const worker = this.find(e.worker)
        const { done, total } = this.works?.progress() ?? { done: 0, total: 1 }
        const quarter = Math.floor((done / total) * 4)
        if (quarter > this.milestone && quarter < 4) {
          this.milestone = quarter
          const amount = ['', 'a quarter', 'half', 'three quarters'][quarter]
          this.chatter(async () => {
            await (foreman ?? worker)?.speak(
              `Tell everyone that ${title} is ${amount} done, and encourage the crew.`,
              `${title} is ${amount} done. Well worked, all!`
            )
          }, true)
          return
        }
        this.chatter(async () => {
          const own = !foreman || worker?.cfg.reportsTo !== boss
          await worker?.speak(
            own
              ? `Tell the court in one short sentence that you have just finished ${e.section.title}.`
              : `Tell ${boss} in one short sentence that you have finished ${e.section.title}.`,
            `${e.section.title} is finished!`
          )
          if (foreman && worker && worker.cfg.reportsTo === boss && Math.random() < 0.5) {
            await sleep(3_000)
            await foreman.speak(
              `${e.worker} just finished ${e.section.title}. Thank ${e.worker} warmly in one short sentence.`,
              `Well done, ${e.worker}!`
            )
          }
        })
        return
      }
      case 'finished':
        this.chatter(async () => {
          await (foreman ?? this.bots[0])?.speak(
            `Announce proudly to everyone that ${e.plan.title} is finished, and invite the King and the Princess to come and see it.`,
            `${e.plan.title} is finished! Your Majesty, Your Highness, come and see!`
          )
          // A palace a royal ordered comes next; otherwise, after the first castle (planned for
          // the court), the court plans its next one itself.
          const ordered = this.courtWorks().ordered
          if (ordered) {
            await sleep(20_000)
            await this.planNextCastle(ordered)
          } else if (
            process.env.WORKS_NEXT === 'overlord' &&
            this.courtWorks().built.length === 0
          ) {
            await sleep(20_000)
            await this.planNextCastle()
          }
        }, true)
        return
    }
  }

  /**
   * A creeper near home is lured away by one courtier (the King's rule, 2026-11-03: a creeper
   * in the hall is a serious matter, worth a courtier): a fit soldier, the nearest, else anyone
   * fit but the Castellan. Every five seconds; a lure is released when its creeper is gone, it
   * has finished, or it has been at it long enough for another to take over.
   */
  private watchCreepers(): void {
    const home = this.household.home
    if (!home) return
    const seen = new Map<number, Point>()
    for (const b of this.bots)
      for (const [id, p] of b.creepersNear(home, CREEPER_WATCH)) seen.set(id, p)
    for (const [id, lure] of this.lures) {
      const bot = this.find(lure.name)
      if (!seen.has(id) || !bot || bot.luring !== id || Date.now() - lure.since > LURE_MS) {
        if (bot?.luring === id) bot.lureCreeper(undefined)
        this.lures.delete(id)
      }
    }
    const captain = this.castellan()
    for (const [id, at] of seen) {
      if (this.lures.has(id)) continue
      const name = chooseLure(
        this.bots.map((b) => {
          const s = b.snapshot()
          const p = b.position()
          return {
            name: b.cfg.name,
            soldier: b.cfg.duty?.kind === 'escort',
            captain: b === captain,
            health: s.health,
            distance: p ? Math.hypot(p.x - at.x, p.z - at.z) : 99,
            unavailable:
              s.status !== 'spawned' ||
              s.doing === 'raiding' ||
              b.luring !== undefined ||
              b.diedWithin(2 * 60_000),
          }
        })
      )
      const bot = name ? this.find(name) : undefined
      if (!bot) continue
      bot.lureCreeper(id)
      this.lures.set(id, { name: bot.cfg.name, since: Date.now() })
      this.work(
        'housekeeping',
        `${bot.cfg.name} lures the creeper at ${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)} away from the hall`
      )
    }
  }

  find(name: string): Bot | undefined {
    return this.bots.find((b) => b.cfg.name.toLowerCase() === name.toLowerCase())
  }

  /**
   * Developer commands, one per line (see the `.command` file in CLAUDE.md):
   *   <bot> build <blueprint> <x> <y> <z> [for <player>]
   *   <bot> commission <blueprint> [at <x> <y> <z>] [for <player>]  (as if a royal asked the bot)
   *   <bot> undo [for <player>]
   */
  // ---- The war game (src/war) ---------------------------------------------------------------

  /**
   * The referee's orders: `war reset <series> <round> <home x y z> <chest x y z>` (a new round:
   * everything forgotten, a home and a storehouse as given), `war raid <enemy chest x y z>
   * <enemy home x y z>` (the captain plans and the side raids), `war end`, `war status`.
   */
  private warCommand(words: string[]): void {
    const war = this.war
    if (!war || !SIDE) return this.log.warn('not at war: COURT_SIDE is not set')
    const [verb] = words
    const nums = (from: number, n: number) => words.slice(from, from + n).map(Number)
    if (verb === 'reset') {
      const [series, round, hx, hy, hz, cx, cy, cz] = nums(1, 8)
      if ([series, round, hx, hy, hz, cx, cy, cz].some((v) => !Number.isFinite(v)))
        return this.log.warn('usage: war reset <series> <round> <home x y z> <chest x y z>')
      this.endRaid('a new round begins')
      this.enemySeen = undefined
      this.household.forgetAll()
      this.estate.clear()
      this.resting.clear()
      this.underway.clear()
      this.homeTrips.clear()
      this.placesCache = undefined
      for (const b of this.bots) b.dropCourtWork()
      war.reset(series, round)
      this.makeHome({ x: hx, y: hy, z: hz }, 'the referee')
      this.household.setStorehouse({ x: cx, y: cy, z: cz }, 'the referee')
      this.work('the war', `round ${round} of series ${series} begins: peace, for now`)
      return
    }
    if (verb === 'raid') {
      const [cx, cy, cz, hx, hy, hz] = nums(1, 6)
      if ([cx, cy, cz, hx, hy, hz].some((v) => !Number.isFinite(v)))
        return this.log.warn('usage: war raid <enemy chest x y z> <enemy home x y z>')
      this.endRaid('a new order')
      war.order({
        side: SIDE.enemy.name,
        names: SIDE.enemy.names,
        chest: { x: cx, y: cy, z: cz },
        home: { x: hx, y: hy, z: hz },
      })
      this.work('the war', `the order: raid the ${SIDE.enemy.name} chest at ${cx},${cy},${cz}`)
      void this.orderRaid().catch((err) => this.log.warn(`the raid failed: ${errMsg(err)}`))
      return
    }
    if (verb === 'open') {
      // war open <enemy chest x y z> <enemy home x y z> [days]: a metals round from now on.
      const [cx, cy, cz, hx, hy, hz, days] = nums(1, 7)
      if ([cx, cy, cz, hx, hy, hz].some((v) => !Number.isFinite(v)))
        return this.log.warn('usage: war open <enemy chest x y z> <enemy home x y z> [days]')
      this.endRaid('a new order')
      const roundDays = Number.isFinite(days) && days > 0 ? days : 10
      war.order(
        {
          side: SIDE.enemy.name,
          names: SIDE.enemy.names,
          chest: { x: cx, y: cy, z: cz },
          home: { x: hx, y: hy, z: hz },
        },
        Date.now(),
        'metals',
        roundDays
      )
      // No bars spent till the captain says so; the mine deep enough for gold (a mine begun in
      // the moment since the reset goes deeper too).
      this.household.metal = { arms: false, tools: false }
      this.household.mineDepth = METALS_MINE_DEPTH
      const mine = this.household.mine
      if (mine && mine.steps < 3 && (mine.depth ?? 0) < METALS_MINE_DEPTH) {
        mine.depth = METALS_MINE_DEPTH
        this.household.setMine(mine)
      }
      this.enemySeen = undefined
      const m = {
        openedAt: Date.now(),
        days: roundDays,
        lastCouncil: 0,
        holding: false,
        timer: undefined as NodeJS.Timeout | undefined,
      }
      this.metals = m
      this.work(
        'the war',
        `anything goes now: the most metal in our own chest after ${m.days} days wins`
      )
      const run = () =>
        void this.council().catch((err) => this.log.warn(`the council failed: ${errMsg(err)}`))
      run()
      m.timer = setInterval(run, COUNCIL_MS)
      return
    }
    if (verb === 'count') {
      void this.countChest().catch((err) => this.log.warn(`the count failed: ${errMsg(err)}`))
      return
    }
    if (verb === 'end') return this.endRaid('the referee ended it')
    if (verb === 'status') {
      const { events, ...rest } = war.data
      return this.log.info(`war: ${JSON.stringify({ ...rest, events: events.length })}`)
    }
    this.log.warn('usage: war reset|raid|open|count|end|status')
  }

  /**
   * A metals round's council (src/war/council.ts): the captain decides who raids, who guards
   * the chest and whether bars may be spent; the rest go about the court's work.
   */
  private async council(): Promise<void> {
    const war = this.war
    const m = this.metals
    const enemy = war?.enemy
    const captain = this.castellan() ?? this.bots[0]
    if (!war || !m || !enemy || !SIDE || !captain || m.holding) return
    const store = this.household.storehouse
    const home = this.household.home
    if (!store || !home) return war.remark('no storehouse: no council')
    m.holding = true
    try {
      const day = Math.min(m.days, 1 + Math.floor((Date.now() - m.openedAt) / COUNCIL_MS))
      const onRaid = this.bots.filter((b) => b.isRaiding).map((b) => b.cfg.name)
      const soldiers = this.bots.filter((b) => b.isGuard()).map((b) => b.cfg.name)
      const book = this.playbook?.forPlanning() ?? { lessons: [], record: [] }
      const stock = this.household.stock.items
      const since = m.lastCouncil || m.openedAt
      const recent = timeline(
        {
          ...war.data,
          orderedAt: m.openedAt,
          events: war.data.events.filter((e) => e.at >= since && e.kind !== 'plan'),
        },
        15
      )
      const members: CouncilBrief['members'] = this.bots.map((b) => {
        const s = b.snapshot()
        const p = b.position()
        return {
          name: b.cfg.name,
          role: b.cfg.role,
          gear: s.gear,
          health: s.health,
          food: s.food,
          home: Boolean(p && Math.hypot(p.x - home.x, p.z - home.z) < 24),
          doing: s.doing,
        }
      })
      if (!war.data.muster)
        war.muster(
          members.map((x) => ({
            name: x.name,
            role: x.role,
            gear: gearWords(x),
            health: x.health,
            food: x.food,
          }))
        )
      const seen = this.enemySeen
      const brief: CouncilBrief = {
        side: sideTitle(SIDE.name),
        captain: captain.cfg.name,
        enemySide: sideTitle(enemy.side),
        day,
        days: m.days,
        members,
        stock,
        home,
        enemyChest: enemy.chest,
        night: captain.isNight(),
        enemySeen: seen
          ? { items: seen.items, minutesAgo: Math.round((Date.now() - seen.at) / 60_000) }
          : undefined,
        goldSeen: this.household.goldSeen,
        ironPickaxe:
          (stock.iron_pickaxe ?? 0) > 0 || this.bots.some((b) => b.carries(/^iron_pickaxe$/) > 0),
        onRaid,
        recent,
        playbook: book.lessons,
        record: book.record,
      }
      const log = this.log.child('war')
      const ai = new OllamaClient(captain.cfg.ai, log)
      const c = await holdCouncil(ai, brief, soldiers, log, {
        model: captain.cfg.ai.orderModel,
        timeoutMs: 180_000,
      })
      if (this.metals !== m || war.phase !== 'raid') return // the round ended meanwhile
      m.lastCouncil = Date.now()
      const line = councilLine(c)
      war.council(c, day, `${line} (${c.by})${c.reason ? `: ${c.reason}` : ''}`)
      war.remark(`day ${day}: our chest holds ${metalWords(stock)}`)
      this.household.metal = { arms: c.arms, tools: c.tools }
      this.work('the war', `day ${day} of ${m.days}, the council (${c.by}): ${line}`)
      if (c.words) captain.chat(c.words)
      // Defenders: those named hold the chest; those no longer named go back to work.
      for (const b of this.bots)
        if (b.isDefending && !c.defenders.includes(b.cfg.name)) void b.stopWar()
      for (const name of c.defenders) {
        const b = this.find(name)
        if (b && !b.isDefending && !b.isRaiding)
          void b.startDefence({ chest: store, onRecovered: (items) => war.recovered(name, items) })
      }
      if (c.raiders.length) war.start()
      for (const name of c.raiders) {
        const b = this.find(name)
        if (!b || b.isRaiding) continue
        // Guarding till now: let go first (a defender stops within a few seconds).
        if (b.isDefending) await b.stopWar()
        void b
          .startRaid({
            chest: enemy.chest,
            store,
            tactic: c.tactic,
            trips: c.trips,
            onGrab: (items) => war.grab(name, items),
            onDeposit: (items) => war.deposit(name, items),
            onLost: () => war.lost(name),
            onDone: (why) => war.raiderDone(name, why),
            onSeen: (items) => {
              this.enemySeen = { items, at: Date.now() }
              war.remark(`their chest held ${metalWords(items)}`, name)
            },
          })
          .finally(() => {
            if (!war.data.raiders[name]?.done) war.raiderDone(name, 'could not go')
          })
      }
    } finally {
      m.holding = false
    }
  }

  /**
   * A restart in the middle of a metals round: the councils carry on where they were, under
   * the last council's limits, and new mines go deep (a restart once ended the councils).
   */
  private resumeMetals(): void {
    const war = this.war
    const d = war?.data
    if (!war || !d || this.metals || d.phase !== 'raid' || d.objective !== 'metals') return
    if (!d.orderedAt || !d.enemy) return
    const lastCouncil = d.events.filter((e) => e.kind === 'plan').at(-1)?.at ?? 0
    const last = d.plan as Partial<Council> | undefined
    this.household.metal = { arms: Boolean(last?.arms), tools: Boolean(last?.tools) }
    this.household.mineDepth = METALS_MINE_DEPTH
    const m = {
      openedAt: d.orderedAt,
      days: d.days ?? 10,
      lastCouncil,
      holding: false,
      timer: undefined as NodeJS.Timeout | undefined,
    }
    this.metals = m
    const run = () =>
      void this.council().catch((err) => this.log.warn(`the council failed: ${errMsg(err)}`))
    const due = Math.max(30_000, (lastCouncil || m.openedAt) + COUNCIL_MS - Date.now())
    this.log.info(
      `the war: the metals round goes on; the next council in ${Math.round(due / 60_000)} min`
    )
    m.timer = setTimeout(() => {
      if (this.metals !== m) return
      run()
      m.timer = setInterval(run, COUNCIL_MS)
    }, due)
  }

  /** The referee's count at a metals round's end: a courtier opens our chest and says what is in it. */
  private async countChest(): Promise<void> {
    const war = this.war
    const home = this.household.home
    if (!war || !home) return
    const gap = (b: Bot) => {
      const p = b.position()
      return p ? Math.hypot(p.x - home.x, p.z - home.z) : Infinity
    }
    const candidates = this.bots
      .filter((b) => b.snapshot().status === 'spawned')
      .sort((a, b) => Number(b.isFree()) - Number(a.isFree()) || gap(a) - gap(b))
    for (const b of candidates) {
      const items = await b.countStorehouse().catch(() => undefined)
      if (!items) continue
      war.count(items, metalWords(items))
      this.work('the war', `${b.cfg.name} counted our chest: ${metalWords(items)}`)
      return
    }
    war.remark('our chest could not be counted')
    this.log.warn('the war: nobody could count our chest')
  }

  /** The captain plans the raid (the model, with the playbook), and the side carries it out. */
  private async orderRaid(): Promise<void> {
    const war = this.war
    const enemy = war?.enemy
    const captain = this.castellan() ?? this.bots[0]
    if (!war || !enemy || !SIDE || !captain) return
    const store = this.household.storehouse
    const home = this.household.home
    if (!store || !home) return war.remark('no storehouse: the order cannot be carried out')
    const soldiers = this.bots.filter((b) => b.isGuard()).map((b) => b.cfg.name)
    const book = this.playbook?.forPlanning() ?? { lessons: [], record: [] }
    const brief: Brief = {
      side: sideTitle(SIDE.name),
      captain: captain.cfg.name,
      enemySide: sideTitle(enemy.side),
      members: this.bots.map((b) => {
        const s = b.snapshot()
        const p = b.position()
        return {
          name: b.cfg.name,
          role: b.cfg.role,
          gear: s.gear,
          health: s.health,
          food: s.food,
          home: Boolean(p && Math.hypot(p.x - home.x, p.z - home.z) < 24),
        }
      }),
      stock: this.household.stock.items,
      home,
      enemyChest: enemy.chest,
      night: captain.isNight(),
      playbook: book.lessons,
      record: book.record,
    }
    // The side as it stands now, for the lessons at the round's end (both sides see both).
    war.muster(
      brief.members.map((m) => ({
        name: m.name,
        role: m.role,
        gear: gearWords(m),
        health: m.health,
        food: m.food,
      }))
    )
    const log = this.log.child('war')
    const ai = new OllamaClient(captain.cfg.ai, log)
    const plan = await planRaid(ai, brief, soldiers, log, {
      model: captain.cfg.ai.orderModel,
      timeoutMs: 180_000,
    })
    if (war.phase !== 'raid') return // called off meanwhile
    war.setPlan(plan)
    this.work(
      'the war',
      `the plan (${plan.by}): ${plan.tactic}, ${plan.when}, ${plan.trips} trip(s); ` +
        `raiders ${plan.raiders.join(', ') || 'none'}; defenders ${plan.defenders.join(', ') || 'none'}`
    )
    if (plan.words) captain.chat(plan.words)
    // The defenders take their posts at once; the raiders set out when the plan says.
    for (const name of plan.defenders) {
      const b = this.find(name)
      if (b)
        void b.startDefence({ chest: store, onRecovered: (items) => war.recovered(name, items) })
    }
    const wait = { cancel: false }
    this.raidWait = wait
    const due = () =>
      plan.when === 'now' || (plan.when === 'day' ? !captain.isNight() : captain.isNight())
    const since = Date.now()
    while (!due() && !wait.cancel && Date.now() - since < WHEN_WAIT_MS) await sleep(10_000)
    if (wait.cancel || war.phase !== 'raid') return
    war.start()
    for (const name of plan.raiders) {
      const b = this.find(name)
      if (!b) {
        war.raiderDone(name, 'not here')
        continue
      }
      void b
        .startRaid({
          chest: enemy.chest,
          store,
          tactic: plan.tactic,
          trips: plan.trips,
          onGrab: (items) => war.grab(name, items),
          onDeposit: (items) => war.deposit(name, items),
          onLost: () => war.lost(name),
          onDone: (why) => war.raiderDone(name, why),
        })
        .finally(() => {
          if (!war.data.raiders[name]?.done) war.raiderDone(name, 'could not go')
        })
    }
  }

  /** The raid is over (the referee's word, or a new round): everyone stops. */
  private endRaid(why: string): void {
    if (this.raidWait) this.raidWait.cancel = true
    if (this.metals?.timer) clearInterval(this.metals.timer)
    this.metals = undefined
    for (const b of this.bots) void b.stopWar()
    if (this.war && this.war.phase === 'raid') {
      this.war.end()
      this.work('the war', `the raid is over: ${why}`)
    }
  }

  runCommand(line: string): void {
    const words = line.trim().split(/\s+/)
    const [name, verb] = words
    if (name?.toLowerCase() === 'war') return this.warCommand(words.slice(1))
    if (name?.toLowerCase() === 'works') return this.worksCommand(words.slice(1))
    if (name?.toLowerCase() === 'household') {
      // household home|storehouse <x> <y> <z> [for <player>]: a home as if they declared it
      const [x, y, z] = words.slice(2, 5).map(Number)
      if (!['home', 'storehouse'].includes(verb) || [x, y, z].some((n) => !Number.isFinite(n)))
        return this.log.warn('usage: household home|storehouse <x> <y> <z> [for <player>]')
      const forIndex = words.indexOf('for')
      const by = forIndex > 0 ? words[forIndex + 1] : 'the court'
      if (verb === 'home') this.makeHome({ x, y, z }, by)
      else this.household.setStorehouse({ x, y, z }, by)
      this.placesCache = undefined
      return this.log.info(`command: the court's ${verb} is now at ${x},${y},${z}`)
    }
    const bot = name ? this.find(name) : undefined
    if (!bot) return this.log.warn(`command for unknown bot: ${line}`)
    const forIndex = words.indexOf('for')
    const requestedBy = forIndex > 0 ? words[forIndex + 1] : 'the court'
    if (verb === 'build') {
      const id = words[2] as BlueprintId
      const [x, y, z] = words.slice(3, 6).map(Number)
      if (!BLUEPRINT_IDS.includes(id) || [x, y, z].some((n) => !Number.isFinite(n))) {
        return this.log.warn(
          `usage: <bot> build <${BLUEPRINT_IDS.join('|')}> <x> <y> <z> [for <player>]`
        )
      }
      this.log.info(`command: ${bot.cfg.name} builds ${id} at ${x},${y},${z} for ${requestedBy}`)
      void bot.startBuild(id, DEFAULT_PALETTE, requestedBy, { at: { x, y, z }, exact: true })
    } else if (verb === 'commission') {
      const id = words[2] as BlueprintId
      const atIndex = words.indexOf('at')
      const [x, y, z] = atIndex > 0 ? words.slice(atIndex + 1, atIndex + 4).map(Number) : []
      const near = atIndex > 0 ? { x, y, z } : undefined
      if (!BLUEPRINT_IDS.includes(id) || (near && [x, y, z].some((n) => !Number.isFinite(n)))) {
        return this.log.warn(
          `usage: <bot> commission <${BLUEPRINT_IDS.join('|')}> [at <x> <y> <z>] [for <player>]`
        )
      }
      this.commission(bot, {
        blueprint: id,
        palette: DEFAULT_PALETTE,
        requestedBy,
        near,
        own: Boolean(bot.cfg.canBuild),
      })
    } else if (verb === 'resume') {
      // <bot> resume <blueprint> <origin x> <y> <z> [turns <0-3>] [for <player>]
      const id = words[2] as BlueprintId
      const [x, y, z] = words.slice(3, 6).map(Number)
      const turnsIndex = words.indexOf('turns')
      const turns = turnsIndex > 0 ? Number(words[turnsIndex + 1]) : 0
      if (!BLUEPRINT_IDS.includes(id) || [x, y, z, turns].some((n) => !Number.isFinite(n))) {
        return this.log.warn(`usage: <bot> resume <blueprint> <x> <y> <z> [turns N] [for <player>]`)
      }
      this.log.info(`command: ${bot.cfg.name} resumes ${id} at ${x},${y},${z} (turns ${turns})`)
      void bot.resumeBuildAt(id, { x, y, z }, turns, requestedBy)
    } else if (verb === 'cast') {
      // <bot> cast <spell> [on <who>] [to <place ...>] [item <x>] [count <n>] [creature <x>] [effect <x>] [for <player>]
      const after = (key: string) => {
        const i = words.indexOf(key)
        return i > 0 ? words[i + 1] : undefined
      }
      const toIndex = words.indexOf('to')
      const stops = ['on', 'item', 'count', 'creature', 'effect', 'for']
      const place =
        toIndex > 0
          ? words
              .slice(toIndex + 1)
              .filter((_, i, rest) => !rest.slice(0, i + 1).some((w) => stops.includes(w)))
              .join(' ')
          : undefined
      void bot.castCommand(words[2] ?? '', {
        target: after('on') ?? (requestedBy === 'the court' ? bot.cfg.name : requestedBy),
        requestedBy,
        args: {
          place,
          item: after('item'),
          count: Number(after('count')) || undefined,
          creature: after('creature'),
          effect: after('effect'),
        },
      })
    } else if (verb === 'run') {
      // Developer tool: a raw server command as this bot. Only this machine writes the command
      // file; the royals and the model never reach it.
      void bot.command(words.slice(2).join(' '))
    } else if (verb === 'fade') {
      void bot.fadeGiftsNow()
    } else if (verb === 'spells') {
      bot.listSpells()
    } else if (verb === 'fetch') {
      // <bot> fetch <dirt|wood|sand|gravel> [count] [for <player>] (survival errands)
      const material = words[2] as Material
      const count = Number(words[3]) || 16
      if (!MATERIALS.includes(material)) {
        return this.log.warn(`usage: <bot> fetch <${MATERIALS.join('|')}> [count] [for <player>]`)
      }
      void bot.startGather(material, count, requestedBy)
    } else if (verb === 'hall') {
      // <bot> hall <roof|floor|light|door|beds> [for <player>] (by hand, survival)
      const work = words[2] as HallWork
      if (
        ![
          'roof',
          'floor',
          'light',
          'door',
          'beds',
          'repair',
          'furnace',
          'chest',
          'reinforce',
        ].includes(work)
      )
        return this.log.warn('usage: <bot> hall <roof|floor|light|door|beds> [for <player>]')
      void bot.startHallWork(work, requestedBy)
    } else if (verb === 'hunt') {
      // <bot> hunt [animals]: hunt for the court's food (survival, the King's rule)
      void bot.startHunt(Number(words[2]) || 2)
    } else if (verb === 'cook') {
      void bot.startCooking()
    } else if (verb === 'mine') {
      void bot.startMining(Number(words[2]) || 16)
    } else if (verb === 'arm') {
      void bot.startArming()
    } else if (verb === 'charcoal') {
      void bot.startCharcoal()
    } else if (verb === 'farm') {
      void bot.startFarming()
    } else if (verb === 'forest') {
      void bot.startForestry()
    } else if (verb === 'fish') {
      void bot.startFishing()
    } else if (verb === 'bed') {
      // <bot> bed: go to bed now, as when a royal lies down at night (survival)
      void bot.goToBed()
    } else if (verb === 'undo') {
      this.log.info(`command: ${bot.cfg.name} takes down its last build`)
      void bot.undoLastBuild(requestedBy)
    } else {
      this.log.warn(`unknown command: ${line}`)
    }
  }

  /** works status | works pause | works resume | works start <design file> */
  private worksCommand(args: string[]): void {
    const [verb, file] = args
    if (verb === 'start' && file) {
      this.startWorks(file)
      return
    }
    if (verb === 'plan') {
      void this.planNextCastle()
      return
    }
    const works = this.works
    if (!works) return this.log.warn('no works in progress')
    if (verb === 'pause') works.paused = true
    else if (verb === 'resume') works.paused = false
    const { done, total, doing } = works.progress()
    this.log.info(
      `works: ${works.plan.title} ${done}/${total}${works.paused ? ' (paused)' : ''}; ` +
        (doing.map((d) => `${d.worker}: ${d.title}`).join('; ') || 'nobody working')
    )
  }

  /** Connect bots one after another; a failure does not stop the others (auto-reconnect takes over). */
  async startAll(staggerMs = 2_000): Promise<void> {
    this.lag.enable()
    this.statusTimer = setInterval(() => this.writeStatus(), STATUS_MS)
    this.statusTimer.unref()
    // The court is in one world; Merlin in every one.
    const away = this.bots.filter((b) => !this.inThisWorld(b))
    for (const bot of away) this.away.add(bot)
    if (this.presence)
      this.log.info(
        `this is ${worldWords(this.presence.here)}; the court is in ${worldWords(this.presence.world)}` +
          (away.length ? ` (not here: ${away.map((b) => b.cfg.name).join(', ')})` : '')
      )
    for (const [i, bot] of this.bots.filter((b) => !this.away.has(b)).entries()) {
      if (i > 0) await sleep(staggerMs)
      try {
        await bot.connect()
      } catch (err) {
        this.log.warn(`${bot.cfg.name} failed to connect: ${errMsg(err)}`)
      }
    }
    this.ready = true
    this.resumeMetals()
    this.runWorks()
    // A palace a royal ordered and the crew free: its plans are drawn now.
    const ordered = this.courtWorks().ordered
    if (ordered && (!this.works || this.works.finished)) {
      setTimeout(() => void this.planNextCastle(ordered), 30_000)
      return
    }
    // Finished before this start and nothing planned since: the court plans its next castle now.
    if (
      this.works?.finished &&
      process.env.WORKS_NEXT === 'overlord' &&
      this.courtWorks().built.length === 0
    )
      setTimeout(() => void this.planNextCastle(), 30_000)
  }

  /** Is this bot in this world: everywhere (Merlin), or where the court is. */
  private inThisWorld(bot: Bot): boolean {
    return !this.presence || bot.cfg.everywhere === true || this.presence.courtHere()
  }

  /**
   * The court follows the King from world to world: its bots join this one or leave it to match
   * the shared presence file (the court of the other world may have changed it). The King's being
   * here is noted, and a court he left here a day ago goes home.
   */
  private async followCourt(): Promise<void> {
    const presence = this.presence
    if (!presence || this.moving || !this.ready) return
    this.moving = true
    try {
      const king = this.king()
      if (king && this.bots.some((b) => b.isOnline(king.player))) presence.noteKing()
      if (presence.returnIfForgotten())
        this.log.info(
          `the King has not been in ${worldWords(presence.here)} for a day: the court goes back to ${worldWords(presence.home)}`
        )
      for (const bot of this.bots) {
        if (bot.cfg.everywhere) continue
        const here = presence.courtHere()
        if (here && this.away.has(bot)) {
          this.away.delete(bot)
          this.log.info(`${bot.cfg.name} comes to ${worldWords(presence.here)}`)
          await bot
            .connect()
            .catch((err) => this.log.warn(`${bot.cfg.name} failed to connect: ${errMsg(err)}`))
          await sleep(2_000)
        } else if (!here && !this.away.has(bot)) {
          this.away.add(bot)
          this.log.info(`${bot.cfg.name} goes to ${worldWords(presence.world)}`)
          await bot.disconnect(`Called to ${worldWords(presence.world)}`)
        }
      }
      await this.gatherSummoned()
    } finally {
      this.moving = false
    }
  }

  /** The King asked Merlin, here, to bring everyone: the court comes over from the other world. */
  private summonCourt(merlin: Bot, by: string): void {
    const presence = this.presence
    if (!presence || rankOf(this.court.find(by)?.role) < rankOf(this.king()?.role)) return
    this.log.info(`${by} calls the court to ${worldWords(presence.here)}`)
    record({
      kind: 'court',
      actor: by,
      text: `${by} calls the court to ${worldWords(presence.here)}`,
    })
    presence.callHere(by)
    this.summoned = { by, at: Date.now(), merlin }
    void this.followCourt()
  }

  /** Once the court has come, Merlin brings them all to the King. */
  private async gatherSummoned(): Promise<void> {
    const summoned = this.summoned
    if (!summoned) return
    const travellers = this.bots.filter((b) => !b.cfg.everywhere)
    const arrived = travellers.every((b) => b.position() !== undefined)
    const waited = Date.now() - summoned.at
    // The other mind's bots come in their own process: give them time too.
    if ((!arrived || (DIVISION && waited < OTHER_MIND_MS)) && waited < SUMMON_WAIT_MS) return
    this.summoned = undefined
    if (!summoned.merlin.isOnline(summoned.by)) return
    await summoned.merlin.castCommand('gather', {
      target: summoned.by,
      requestedBy: summoned.by,
      args: {},
    })
  }

  /** What this process is and does now, for the admin (`.state/status-<division>.json`). */
  private writeStatus(): void {
    try {
      const first = this.bots.find((b) => b.state.status === 'spawned')
      const mem = process.memoryUsage()
      const merlin = this.bots.find((b) => b.cfg.magic && b.state.status === 'spawned')
      // Players, not courtiers (of either mind).
      const courtiers = new Set(this.cfg.bots.map((b) => b.name.toLowerCase()))
      writeStatus(path.join(STATE_DIR, `status-${DIVISION ?? 'all'}.json`), {
        at: Date.now(),
        division: DIVISION ?? 'all',
        ...(WORLD ? { world: WORLD } : {}),
        ...(this.presence ? { courtWorld: this.presence.world } : {}),
        process: {
          pid: process.pid,
          startedAt: this.startedAt,
          rssMb: Math.round(mem.rss / 1048576),
          heapMb: Math.round(mem.heapUsed / 1048576),
          lagMs: Math.round(this.lag.mean / 1e6),
        },
        bots: this.bots.map((b) => ({
          ...b.snapshot(),
          ...(this.away.has(b) ? { status: 'away' } : {}),
        })),
        players: (first?.playersOnline() ?? [])
          .filter((p) => !courtiers.has(p.name.toLowerCase()))
          .map((p) => {
            const royal = this.court.find(p.name)
            return { ...p, ...(royal ? { title: royal.title } : {}) }
          }),
        ...(this.household.home
          ? {
              home: {
                x: this.household.home.x,
                y: this.household.home.y,
                z: this.household.home.z,
              },
            }
          : {}),
        underway: [...this.underway],
        resting: [...this.resting].filter(([, until]) => until > Date.now()).map(([kind]) => kind),
        ...(merlin ? { magicLeft: merlin.magicLeft() } : {}),
        ...(this.war
          ? {
              war: {
                side: this.war.side,
                phase: this.war.phase,
                done: this.war.data.done,
                brought: Object.values(this.war.data.brought).reduce((n, k) => n + k, 0),
                kills: this.war.data.kills,
                deaths: this.war.data.deaths,
              },
            }
          : {}),
      })
      this.lag.reset()
    } catch (err) {
      this.log.debug(`could not write the status: ${errMsg(err)}`)
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.worksTimer)
    clearInterval(this.statusTimer)
    await Promise.all(this.bots.map((bot) => bot.disconnect('Shutting down')))
  }
}

/** A royal's order for great works, as the bot that took it heard it (see Bot.act). */
/** Courtiers within this many blocks of home are at home (by night: inside the hall). */
const HOME_RADIUS = 10
const HOME_RADIUS_NIGHT = 2.5
/** Farther than this, Merlin portals them home rather than letting them walk. */
const HOME_WALK = 96
/** At dusk, courtiers further than this out on errands are brought home by Merlin. */
const DUSK_FAR = 48
/** Work that came to nothing rests this long before it is tried again. */
const REST_MS = 10 * 60_000
/** How often the Castellan takes stock of what the court needs, and asks Merlin for magic. */
const HOUSEKEEPING_MS = 60_000
const MAGIC_REQUEST_MS = 3 * 60_000
/** Merlin gathers the court to the King when all have come, or after this long anyway. */
const SUMMON_WAIT_MS = 3 * 60_000
/** The other mind's bots join in their own time: at least this long before the gathering. */
const OTHER_MIND_MS = 2 * 60_000
/** A bucket is three iron. */
const IRON_FOR_BUCKET = 3
/** Below this many meals and raw meat in the storehouse, a soldier off the round hunts. */
const ARMY_FOOD = 16
/** Soldiers on patrol at once, and how long a shift walks before the next takes over. */
const PATROL_SIZE = 4
const SHIFT_MS = 15 * 60_000
/** The round runs this far outside the estate's buildings (or this far round home without). */
const PATROL_MARGIN = 6
const PATROL_RADIUS = 16
/** Courtiers' respawn points are looked over this often; a tap that did not take waits. */
const BED_ROUND_MS = 30_000
const BED_RETRY_MS = 10 * 60_000
/** A soldier's ask for a portal home stands this long. */
const PORTAL_ASK_MS = 2 * 60_000
/** Blasts this near home are remembered this long; what lay this near one was blown away. */
const ESTATE_BLAST_REACH = 64
const BLAST_MEMORY_MS = 30 * 60_000
const BLAST_RADIUS = 5
/** The army's round: its report to the household, a sword made, the blessing asked for. */
const ARMY_ROUND_MS = 60_000
/** Sarge asks the King for the blessing at most this often. */
const BLESS_ASK_MS = 30 * 60_000
/** The army is blessed once a day (the gifts fade after a day). */
const BLESSING_MS = 24 * 60 * 60_000
/** The Castellan asks the King for Merlin's help at most this often. */
const ASK_MS = 20 * 60_000
/** The King's yes or no counts this long after the question. */
const ANSWER_MS = 5 * 60_000
/** Food a courtier may carry (see bot/survival.ts). */
const FOOD_ITEM = new RegExp(`^(${FOODS.join('|')})$`)
/** Before sending the same bot home again. */
const HOME_RETRY_MS = 60_000

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/** A royal's errand the Castellan hands to his staff. */
interface Errand {
  material: Material
  count: number
  requestedBy: string
  from: string
  toStore?: boolean
}

interface WorksOrder {
  what: string
  requestedBy: string
  /** The coordinates named (y may be missing), or where the royal stood. */
  near?: { x: number; y?: number; z: number }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What a bot hands the court when a royal asks it for a build (see Bot.act). */
interface CommissionRequest {
  blueprint: BlueprintId
  palette: Palette
  requestedBy: string
  /** Where the royal stood, as the bot saw it. */
  near?: Point
  /** The bot builds it itself (a builder asked directly). */
  own: boolean
}

function isCastellan(cfg: AppConfig, name: string): boolean {
  return /castellan/i.test(cfg.bots.find((b) => b.name === name)?.role ?? '')
}
