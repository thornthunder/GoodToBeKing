/**
 * Joins as a silent surveyor and reports, every so often, what the pathfinder makes of the world
 * where it stands: which chunk columns round it are loaded, what the blocks at a few spots are,
 * and whether it finds a way to a goal (with the court's survival movements). Teleport it from
 * the server console once it has spawned (`wait=` seconds leaves time for that).
 *
 *   tsx scripts/probe-path.ts <gx> <gy> <gz> [rounds=6] [wait=45] [every=20] [at=x,y,z ...]
 */
import { serverOptions } from '../src/bot/Bot'
import { createBot } from 'mineflayer-bedrock'
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { defaultBotConfig } from '../src/config'

const nums = process.argv.slice(2).filter((a) => !a.includes('='))
const [gx, gy, gz] = nums.map(Number)
const opt = (k: string, d: number) =>
  Number(process.argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
const rounds = opt('rounds', 6)
const waitSeconds = opt('wait', 45)
const every = opt('every', 20)
const spots = process.argv
  .filter((a) => a.startsWith('at='))
  .map((a) => a.slice(3).split(',').map(Number))

const cfg = defaultBotConfig()
const bot = createBot({
  ...serverOptions(cfg.server),
  username: 'Surveyor',
  auth: 'offline',
  hideErrors: true,
})
bot.loadPlugin(pathfinder)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

bot.once('spawn', async () => {
  console.log(`spawned at ${bot.entity.position}`)
  await sleep(waitSeconds * 1000)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const movements = new Movements(bot as any)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  movements.allowSprinting = true
  movements.canOpenDoors = true
  movements.allowParkour = false
  movements.maxDropDown = 3
  bot.pathfinder.setMovements(movements)
  for (let round = 1; round <= rounds; round++) {
    const p = bot.entity.position
    const cx = Math.floor(p.x / 16)
    const cz = Math.floor(p.z / 16)
    const rows: string[] = []
    for (let dz = -3; dz <= 3; dz++) {
      let row = ''
      for (let dx = -3; dx <= 3; dx++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const col = (bot.world as any).getColumn?.(cx + dx, cz + dz)
        row += col ? (dx === 0 && dz === 0 ? '@' : '#') : '.'
      }
      rows.push(row)
    }
    console.log(
      `--- round ${round} at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} (chunk ${cx},${cz}); columns loaded round it (# loaded, . not):`
    )
    for (const r of rows) console.log(`    ${r}`)
    const under = bot.blockAt(p.floored().offset(0, -1, 0))
    console.log(`    standing on ${under?.name ?? 'unknown'} (bb ${under?.boundingBox ?? '?'})`)
    for (const [x, y, z] of spots) {
      const b = bot.blockAt(new Vec3(x, y, z))
      console.log(
        `    block ${x},${y},${z}: ${b ? `${b.name} (bb ${b.boundingBox}, shapes ${JSON.stringify(b.shapes)})` : 'UNLOADED'}`
      )
    }
    for (const goal of [
      { name: `GoalNear ${gx},${gy},${gz}`, goal: new goals.GoalNear(gx, gy, gz, 2) },
      { name: `GoalNearXZ ${gx},${gz}`, goal: new goals.GoalNearXZ(gx, gz, 6) },
    ]) {
      const t0 = Date.now()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gen = (bot.pathfinder as any).getPathFromTo(movements, bot.entity.position, goal.goal, {
        timeout: 4000,
      })
      let result: { status: string; visitedNodes: number; path: unknown[] } | undefined
      for (const step of gen) {
        result = step.result
        if (result && result.status !== 'partial') break
      }
      console.log(
        `    ${goal.name}: ${result?.status} after ${Date.now() - t0} ms, ${result?.visitedNodes} nodes visited, path of ${result?.path.length}`
      )
    }
    if (round < rounds) await sleep(every * 1000)
  }
  bot.quit('probe done')
  setTimeout(() => process.exit(0), 1000)
})
bot.on('error', (e) => console.log('error', e.message))
bot.on('kicked', (r) => console.log('kicked', JSON.stringify(r)))
setTimeout(
  () => {
    console.log('timed out')
    process.exit(2)
  },
  (120 + waitSeconds + rounds * (every + 10)) * 1000
)
