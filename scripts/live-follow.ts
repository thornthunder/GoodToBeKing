/**
 * Live end-to-end test of walking, against the real server in .env (MC_HOST / MC_PORT).
 *
 * Two temporary players join: "TestMerlin" (the real Bot + OllamaBrain, with a test court in
 * which the second player is a prince) and "Apprentice" (a plain mineflayer-bedrock bot).
 * Apprentice says "TestMerlin follow me", walks away and checks TestMerlin kept up; then says
 * "stop", walks back and checks TestMerlin stayed. Both leave afterwards. Their chat is visible
 * in game.
 */
import { createBot } from 'mineflayer-bedrock'
import { Movements, goals, pathfinder, type Pathfinder } from 'mineflayer-pathfinder'
import { OllamaBrain } from '../src/ai/OllamaBrain'
import { OllamaClient } from '../src/ai/OllamaClient'
import { Bot } from '../src/bot/Bot'
import { defaultBotConfig } from '../src/config'
import { CourtRoster } from '../src/court'
import { createLogger, setLogLevel } from '../src/logger'
import { sleep } from '../src/util'

const WALK = 10

async function main(): Promise<void> {
  setLogLevel('info')
  const log = createLogger('live-follow')
  const base = defaultBotConfig()
  const cfg = {
    ...base,
    name: 'TestMerlin',
    autoReconnect: false,
    chat: { ...base.chat, greeting: undefined, greetVisitors: false },
  }
  const court = new CourtRoster({
    realm: 'the test realm',
    charter: '',
    members: [{ player: 'Apprentice', role: 'prince', title: 'Prince', address: 'Your Highness' }],
  })
  const brain = new OllamaBrain(cfg, new OllamaClient(cfg.ai, log.child('ollama')), court, log)
  const merlin = new Bot(cfg, brain, log.child('TestMerlin'), { fellowBots: ['TestMerlin'] })
  await merlin.connect()
  log.info('TestMerlin is in the world')

  const leader = createBot({
    host: cfg.server.host,
    port: cfg.server.port,
    username: 'Apprentice',
    auth: 'offline',
    hideErrors: true,
  }) as ReturnType<typeof createBot> & { pathfinder: Pathfinder }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  leader.loadPlugin(pathfinder as any)
  await new Promise<void>((resolve) => leader.once('spawn', () => resolve()))
  await leader.waitForChunksToLoad()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const movements = new Movements(leader as any)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  leader.pathfinder.setMovements(movements)
  await sleep(3_000)

  const gap = () => {
    const other = leader.players.TestMerlin?.entity
    return other ? leader.entity.position.distanceTo(other.position) : Infinity
  }
  const walk = async (dx: number) => {
    const p = leader.entity.position
    await leader.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z, 1))
  }

  log.info(`start: gap ${gap().toFixed(1)} blocks`)
  leader.chat('TestMerlin follow me')
  await sleep(4_000)
  await walk(WALK)
  await sleep(5_000)
  const followedGap = gap()
  log.info(`after walking ${WALK} blocks away: gap ${followedGap.toFixed(1)} blocks`)

  leader.chat('stop TestMerlin')
  await sleep(4_000)
  await walk(-WALK)
  await sleep(4_000)
  const stayedGap = gap()
  log.info(`after "stop" and walking back: gap ${stayedGap.toFixed(1)} blocks`)

  const followed = followedGap <= 4
  const stayed = stayedGap >= WALK - 3
  log.info(`${followed ? 'PASS' : 'FAIL'}: followed (gap ${followedGap.toFixed(1)} <= 4)`)
  log.info(`${stayed ? 'PASS' : 'FAIL'}: stopped (gap ${stayedGap.toFixed(1)} >= ${WALK - 3})`)

  leader.quit('test done')
  await merlin.disconnect('test done')
  await sleep(1_000)
  process.exit(followed && stayed ? 0 : 1)
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
