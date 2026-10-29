import fs from 'node:fs'
import path from 'node:path'
import { CourtMemory } from '../ai/CourtMemory'
import { CourtRules, OrderBook } from '../ai/orders'
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
import { Overlord, overlordClient } from '../ai/Overlord'
import type { Rect } from '../build/design'
import type { AppConfig } from '../config'
import { CourtRoster } from '../court'
import type { Logger } from '../logger'
import { errMsg, sleep } from '../util'
import { Bot } from './Bot'
import { MATERIALS, type Material } from './gathering'
import { Household } from '../household'
import { doorCells, lightCells, repairCells, roofCells, surveyHall } from '../build/hall'
import { plan, type CourtState, type StewardAction } from '../steward'
import { RAW } from './cooking'
import { farmNeed } from '../build/farm'
import { FOODS } from './survival'
import type { HallWork } from '../ai/Brain'
import { ChatFloor } from './ChatFloor'

/** Runtime state that should survive restarts (git-ignored). */
const STATE_DIR = '.state'

/** A palace a royal orders goes up within this many blocks of the spot they chose. */
const ORDERED_RADIUS = 48

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
  works?: Works
  private worksTimer?: NodeJS.Timeout
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

  constructor(
    cfg: AppConfig,
    private readonly log: Logger
  ) {
    this.cfg = cfg
    const court = new CourtRoster(cfg.court)
    this.court = court
    const botNames = cfg.bots.map((b) => b.name)
    // Who speaks: bots in configured order for the royals; the Castellan first for guests.
    const castellanFirst = [...botNames].sort(
      (a, b) => Number(isCastellan(cfg, b)) - Number(isCastellan(cfg, a))
    )
    const floor = new ChatFloor(botNames, castellanFirst)
    const staff = cfg.bots.map((b) => ({
      name: b.name,
      role: b.role,
      canBuild: b.canBuild,
      reportsTo: b.reportsTo,
    }))
    // The rules the royal family lays down bind the whole court.
    const rules = new CourtRules(path.resolve(STATE_DIR, 'rules.json'))
    // What each bot built, so "take it down" removes only that bot's own blocks.
    const builds = new BuildLog(path.resolve(STATE_DIR, 'builds.json'))
    for (const botCfg of cfg.bots) {
      const botLog = log.child(botCfg.name)
      const ai = new OllamaClient(botCfg.ai, botLog.child('ollama'))
      const hails = new HailLog(path.resolve(STATE_DIR, `${botCfg.name}.hails.json`))
      const magic = botCfg.magic
        ? new Magic({
            file: path.resolve(STATE_DIR, `magic-${botCfg.name.toLowerCase()}.json`),
            court: botNames,
            places: () => this.places(),
          })
        : undefined
      const brain = new OllamaBrain(botCfg, ai, court, botLog.child('brain'), {
        household: this.household,
        hails,
        // Each bot remembers only what it heard itself, so one can keep a secret and news
        // travels by being told.
        memory: new CourtMemory(
          path.resolve(STATE_DIR, `memory-${botCfg.name.toLowerCase()}.json`)
        ),
        staff,
        orders: new OrderBook(path.resolve(STATE_DIR, `orders-${botCfg.name.toLowerCase()}.json`)),
        rules,
        magic,
        commissions: this.commissions,
      })
      const bot = new Bot(botCfg, brain, botLog, {
        // Our own helper scripts' players (the surveyor) are ignored like fellow bots.
        fellowBots: [
          ...botNames,
          ...(process.env.IGNORE_PLAYERS ?? 'Surveyor').split(',').filter(Boolean),
        ],
        buildLog: builds,
        floor,
        court,
        works: () => this.worksLine(),
        magic,
        household: this.household,
      })
      bot.on('chat', (event: { from: string }) => {
        if (court.find(event.from)) this.lastRoyalLine = Date.now()
      })
      bot.on('commission', (request: CommissionRequest) => this.commission(bot, request))
      bot.on('works', (order: WorksOrder) => void this.orderWorks(bot, order))
      bot.on('gather', (errand: Errand) => void this.sendOnErrand(bot, errand))
      bot.on(
        'hallwork',
        (job: { work: HallWork; requestedBy: string }) => void this.sendToHall(bot, job)
      )
      bot.on('home', (h: { requestedBy: string; at?: Point }) => {
        if (!h.at) return
        const home = this.household.setHome(h.at, h.requestedBy)
        this.placesCache = undefined
        this.log.info(`${h.requestedBy} made ${home.x},${home.y},${home.z} the court's home`)
      })
      bot.on('storehouse', (s: { requestedBy: string; at: Point }) => {
        if (this.household.storehouse && samePoint(this.household.storehouse, s.at)) return
        this.household.setStorehouse(s.at, s.requestedBy)
        this.placesCache = undefined
        this.log.info(
          `${s.requestedBy} made the chest at ${s.at.x},${s.at.y},${s.at.z} the storehouse`
        )
      })
      this.bots.push(bot)
    }
    // Carry on with whatever the court was last building (the overlord's design, once there is one).
    const current = this.courtWorks().current ?? cfg.worksDesign
    if (current) this.startWorks(current)
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
      if (!bot.isFree()) continue
      const p = bot.position()
      if (!p) continue
      const far = Math.hypot(p.x - home.x - 0.5, p.z - home.z - 0.5)
      // At night in survival everyone comes inside the hall; by day near it will do.
      const radius = bot.isNight() && !bot.buildsByMagic() ? HOME_RADIUS_NIGHT : HOME_RADIUS
      if (far <= radius && Math.abs(p.y - home.y) < 4) {
        this.homeTrips.delete(bot.cfg.name)
        continue
      }
      const trip = this.homeTrips.get(bot.cfg.name) ?? { at: 0, walks: 0 }
      if (now - trip.at < HOME_RETRY_MS) continue
      const merlin = this.bots.find((b) => b.magicAwake())
      // By night nobody walks through the dark: Merlin brings them in.
      const dark = bot.isNight() && !bot.buildsByMagic()
      if ((far > HOME_WALK || trip.walks >= 2 || dark) && merlin) {
        this.homeTrips.set(bot.cfg.name, { at: now, walks: 0 })
        this.log.info(`${merlin.cfg.name} sends ${bot.cfg.name} home by portal`)
        void merlin.castCommand('portal', {
          target: bot.cfg.name,
          requestedBy: merlin.cfg.name,
          args: { place: 'home' },
        })
      } else if (far <= HOME_WALK) {
        this.homeTrips.set(bot.cfg.name, { at: now, walks: trip.walks + 1 })
        bot.goTo(home, 'home')
      }
    }
  }

  private lastInspection = 0
  private lastHousekeeping = 0
  private lastMagicRequest = 0
  /** What the Castellan last asked the royal family for, and when (so he does not nag). */
  private readonly asked = new Map<string, number>()

  /**
   * The Castellan keeps house (survival): every minute he takes stock of what the court needs
   * (see steward.ts) and sees to it: builders for the hall, errands for wood, and Merlin's magic
   * for what cannot be had by hand, asking the royal family instead when one is near.
   */
  private async keepHouse(): Promise<void> {
    const home = this.household.home
    if (!home || Date.now() - this.lastHousekeeping < HOUSEKEEPING_MS) return
    const castellan = this.bots.find(
      (b) => !b.cfg.canBuild && this.bots.some((w) => w.cfg.reportsTo === b.cfg.name)
    )
    const eyes = this.bots.find((b) => {
      const p = b.position()
      return p && !b.buildsByMagic() && Math.hypot(p.x - home.x, p.z - home.z) < 32
    })
    if (!castellan || castellan.buildsByMagic() || !eyes) return
    this.lastHousekeeping = Date.now()
    const names = (x: number, y: number, z: number) => eyes.nameAt(x, y, z)
    const surveyed = surveyHall(names, home)
    // Whole: remember it, so damage later (endermen, creepers) can be measured against it.
    if (typeof surveyed !== 'string') this.household.setHall(surveyed)
    const hall = typeof surveyed === 'string' ? this.household.hall : surveyed
    if (!hall) return void this.log.info(`housekeeping: cannot see the hall (${surveyed})`)
    const merlin = this.bots.find((b) => b.cfg.magic)
    const staff = this.bots.filter(
      (b) => b.cfg.reportsTo?.toLowerCase() === castellan.cfg.name.toLowerCase() && !b.cfg.magic
    )
    const freeBuilder = staff.find((b) => b.cfg.canBuild && b.isFree() && !b.buildsByMagic())
    const carrying = (items: RegExp) =>
      staff.find((b) => b.cfg.canBuild && b.isFree() && b.carries(items) > 0)?.cfg.name
    let beds = 0
    for (const [x, z] of hall.inside) if (/bed$/.test(names(x, hall.floorY, z) ?? '')) beds++
    const stock = this.household.stock.items
    const sum = (re: RegExp) =>
      Object.entries(stock)
        .filter(([n]) => re.test(n))
        .reduce((total, [, n]) => total + n, 0)
    const royals = this.bots
      .flatMap((b) => this.court.members.map((m) => b.playerPosition(m.player)))
      .filter((p): p is Point => p !== undefined)
    const near = (b: Bot | undefined) => {
      const p = b?.position()
      return p !== undefined && royals.some((r) => Math.hypot(r.x - p.x, r.z - p.z) < 32)
    }
    const state: CourtState = {
      royalNear: near(castellan) || near(merlin),
      merlinAwake: merlin?.magicAwake() ?? false,
      magicLeft: merlin?.magicLeft() ?? 0,
      guardsUnarmed: this.bots
        .filter((b) => b.isGuard() && b.position() && b.carries(/_(sword|axe)$/) === 0)
        .map((b) => b.cfg.name),
      courtiers: this.bots.length,
      // A bed is two blocks.
      bedsInHall: Math.floor(beds / 2),
      freeBuilder: freeBuilder?.cfg.name,
      builderWithBeds: carrying(/^bed$/),
      builderWithCoal: carrying(/^(coal|charcoal)$/),
      hall: {
        roof: roofCells(hall, names).length,
        door: doorCells(hall, names).length,
        light: lightCells(hall, names).length,
      },
      storeHasCoal: sum(/^(coal|charcoal)$/) > 0,
      withoutFood: this.bots
        .filter((b) => b.position() && b.carries(FOOD_ITEM) === 0)
        .map((b) => b.cfg.name),
      foodInStore: sum(FOOD_ITEM) - sum(RAW),
      rawInStore: sum(RAW),
      furnace: hall.inside.some(([x, z]) => /furnace$/.test(names(x, hall.floorY, z) ?? '')),
      builderWithFurnace: carrying(/^furnace$/),
      farm: { exists: Boolean(this.household.farm), work: this.farmWork(names) },
      seeds: sum(/^wheat_seeds$/) + this.bots.reduce((n, b) => n + b.carries(/^wheat_seeds$/), 0),
      // Guards first: they carry swords. Then anyone of the staff.
      freeHunter: (
        staff.find((b) => b.isGuard() && b.isFree() && !b.buildsByMagic()) ??
        staff.find((b) => b.isFree() && !b.buildsByMagic())
      )?.cfg.name,
      woodInStore: sum(/_log$/) + Math.floor(sum(/_planks$/) / 4),
      freeHand: staff.find((b) => b.isFree() && !b.buildsByMagic())?.cfg.name,
      storehouse: Boolean(this.household.storehouse),
    }
    // Beds in the hall: each courtier taps one, so it respawns at home (one a round).
    if (beds > 0) {
      const homeless = this.bots.find(
        (b) => b.position() && b.isFree() && !this.household.spawnOf(b.cfg.name)
      )
      if (homeless) {
        void homeless.setSpawnAtBed().then((bed) => {
          if (bed) this.household.setSpawn(homeless.cfg.name, bed)
        })
      }
    }
    const actions = plan(state)
    this.log.debug(`housekeeping: ${JSON.stringify(state)} -> ${JSON.stringify(actions)}`)
    for (const action of actions) await this.carryOutHousekeeping(castellan, merlin, action)
  }

  /** Squares of the field that want tilling, planting or harvesting now. */
  private farmWork(names: (x: number, y: number, z: number) => string | undefined): number {
    const farm = this.household.farm
    if (!farm) return 0
    const eyes = this.bots.find((b) => {
      const p = b.position()
      return p && Math.hypot(p.x - farm.cells[0][0], p.z - farm.cells[0][1]) < 48
    })
    let work = 0
    for (const [x, z] of farm.cells) {
      const growth = eyes?.blockProperty(x, farm.y + 1, z, 'growth')
      if (farmNeed(names(x, farm.y, z), names(x, farm.y + 1, z), Number(growth ?? 0))) work++
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
        this.log.info(
          `housekeeping: ${action.work} for the hall${builder ? ` by ${builder.cfg.name}` : ''}`
        )
        if (builder) void builder.startHallWork(action.work, castellan.cfg.name)
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
        this.log.info(`housekeeping: ${hunter.cfg.name} goes hunting for the court's food`)
        void hunter.startHunt(action.animals)
        return
      }
      case 'farm': {
        const farmer = by(action.by)
        if (!farmer) return
        this.log.info(`housekeeping: ${farmer.cfg.name} tends the wheat field`)
        void farmer.startFarming()
        return
      }
      case 'cook': {
        const cook = by(action.by)
        if (!cook) return
        this.log.info(`housekeeping: ${cook.cfg.name} cooks the meat in the storehouse`)
        void cook.startCooking()
        return
      }
      case 'errand':
        this.log.info(`housekeeping: ${action.count} ${action.material} for the storehouse`)
        void this.sendOnErrand(castellan, {
          material: action.material,
          count: action.count,
          requestedBy: castellan.cfg.name,
          from: castellan.cfg.name,
          toStore: true,
        })
        return
      case 'ask': {
        if (Date.now() - (this.asked.get(action.what) ?? 0) < 15 * 60_000) return
        this.asked.set(action.what, Date.now())
        this.log.info(`housekeeping: asking the royal family for ${action.what}`)
        await castellan.speak(
          `The court needs ${action.what}, which only Merlin's magic can provide just now. Ask ` +
            'the royal family nearby, politely and in one short sentence, whether Merlin may ' +
            'conjure it.',
          `Your Majesty, might Merlin conjure ${action.what}?`
        )
        return
      }
      case 'magic': {
        if (!merlin || Date.now() - this.lastMagicRequest < MAGIC_REQUEST_MS) return
        this.lastMagicRequest = Date.now()
        const before = merlin.magicLeft()
        this.log.info(
          `housekeeping: ${castellan.cfg.name} asks ${merlin.cfg.name} for ${action.why}`
        )
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
        if (merlin.magicLeft() >= before) return
        await merlin.speak(
          `At Festaris's request you have just conjured ${action.why}. Say so in one short, ` +
            'magical sentence.',
          'There! It is done.'
        )
        // The beds or coal go straight to work.
        const then = action.then
        const worker = by(action.to)
        if (then && worker)
          setTimeout(() => void worker.startHallWork(then, castellan.cfg.name), 2_000)
      }
    }
  }

  /**
   * The Castellan's rounds (survival): every few minutes, compare the hall with its shape as last
   * seen whole; if walls or roof have holes (endermen take dirt, creepers blow it up), send a
   * free builder to repair them.
   */
  private async inspectHall(): Promise<void> {
    const hall = this.household.hall
    const home = this.household.home
    if (!hall || !home || Date.now() - this.lastInspection < INSPECT_MS) return
    const castellan = this.bots.find(
      (b) =>
        !b.cfg.canBuild && this.bots.some((w) => w.cfg.reportsTo === b.cfg.name && w.cfg.canBuild)
    )
    // Someone close enough to see it, in survival.
    const eyes = this.bots.find((b) => {
      const p = b.position()
      return p && !b.buildsByMagic() && Math.hypot(p.x - home.x, p.z - home.z) < 32
    })
    if (!castellan || !eyes) return
    this.lastInspection = Date.now()
    const holes = repairCells(hall, (x, y, z) => eyes.nameAt(x, y, z)).length
    if (holes === 0) return
    this.log.info(`the hall has ${holes} holes in its walls or roof`)
    await this.sendToHall(castellan, { work: 'repair', requestedBy: castellan.cfg.name }, true)
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
  private readonly household = new Household(path.resolve(STATE_DIR, 'household.json'))
  /** When each bot was last sent home, and how many walks in a row did not get it there. */
  private readonly homeTrips = new Map<string, { at: number; walks: number }>()

  /** Named places of the castles built and being built (for Merlin's portal), cached a while. */
  private places(): Place[] {
    if (this.placesCache && Date.now() - this.placesCache.at < 10 * 60_000) {
      return this.placesCache.places
    }
    const works = this.courtWorks()
    const files = [...works.built, ...(works.current ? [works.current] : [])].map((f) =>
      path.resolve(f.replace(/\\/g, '/'))
    )
    const places = placesFromFiles([...new Set(files)])
    // The household's own places, for Merlin's portal: "take us home".
    const { home, storehouse } = this.household
    if (home) places.push({ name: 'home', x: home.x + 0.5, y: home.y, z: home.z + 0.5 })
    if (storehouse)
      places.push({
        name: 'the storehouse',
        x: storehouse.x + 0.5,
        y: storehouse.y + 1,
        z: storehouse.z + 0.5,
      })
    this.placesCache = { at: Date.now(), places }
    return places
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
      const zone = ordered
        ? { center: ordered.near, radius: ORDERED_RADIUS }
        : this.bots.find((b) => b.cfg.buildZone)?.cfg.buildZone
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
      // The royal family's wishes first, then the castle.
      this.assignCommissions()
      this.works?.tick(this.workers())
      // Whoever is still free afterwards goes home.
      this.sendHome()
      void this.inspectHall()
      void this.keepHouse()
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

  find(name: string): Bot | undefined {
    return this.bots.find((b) => b.cfg.name.toLowerCase() === name.toLowerCase())
  }

  /**
   * Developer commands, one per line (see the `.command` file in CLAUDE.md):
   *   <bot> build <blueprint> <x> <y> <z> [for <player>]
   *   <bot> commission <blueprint> [at <x> <y> <z>] [for <player>]  (as if a royal asked the bot)
   *   <bot> undo [for <player>]
   */
  runCommand(line: string): void {
    const words = line.trim().split(/\s+/)
    const [name, verb] = words
    if (name?.toLowerCase() === 'works') return this.worksCommand(words.slice(1))
    if (name?.toLowerCase() === 'household') {
      // household home|storehouse <x> <y> <z>
      const [x, y, z] = words.slice(2, 5).map(Number)
      if (!['home', 'storehouse'].includes(verb) || [x, y, z].some((n) => !Number.isFinite(n)))
        return this.log.warn('usage: household home|storehouse <x> <y> <z>')
      if (verb === 'home') this.household.setHome({ x, y, z }, 'the court')
      else this.household.setStorehouse({ x, y, z }, 'the court')
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
      if (!['roof', 'floor', 'light', 'door', 'beds', 'repair', 'furnace'].includes(work))
        return this.log.warn('usage: <bot> hall <roof|floor|light|door|beds> [for <player>]')
      void bot.startHallWork(work, requestedBy)
    } else if (verb === 'hunt') {
      // <bot> hunt [animals]: hunt for the court's food (survival, the King's rule)
      void bot.startHunt(Number(words[2]) || 2)
    } else if (verb === 'cook') {
      void bot.startCooking()
    } else if (verb === 'farm') {
      void bot.startFarming()
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
    for (const [i, bot] of this.bots.entries()) {
      if (i > 0) await sleep(staggerMs)
      try {
        await bot.connect()
      } catch (err) {
        this.log.warn(`${bot.cfg.name} failed to connect: ${errMsg(err)}`)
      }
    }
    this.ready = true
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

  async stopAll(): Promise<void> {
    clearInterval(this.worksTimer)
    await Promise.all(this.bots.map((bot) => bot.disconnect('Shutting down')))
  }
}

/** A royal's order for great works, as the bot that took it heard it (see Bot.act). */
/** Courtiers within this many blocks of home are at home (by night: inside the hall). */
const HOME_RADIUS = 10
const HOME_RADIUS_NIGHT = 2.5
/** Farther than this, Merlin portals them home rather than letting them walk. */
const HOME_WALK = 96
/** How often the Castellan takes stock of what the court needs, and asks Merlin for magic. */
const HOUSEKEEPING_MS = 60_000
const MAGIC_REQUEST_MS = 3 * 60_000
/** Food a courtier may carry (see bot/survival.ts). */
const FOOD_ITEM = new RegExp(`^(${FOODS.join('|')})$`)
/** How often the Castellan looks the hall over for damage. */
const INSPECT_MS = 3 * 60_000
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
