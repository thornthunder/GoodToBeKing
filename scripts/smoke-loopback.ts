/**
 * Loopback smoke test: starts a bedrock-protocol server in-process, connects a Bot to it
 * with a scripted brain, and checks that chat flows both ways. No Minecraft server, no Ollama.
 */
import type { EventEmitter } from 'node:events'
import bedrock, { type ServerOptions } from 'bedrock-protocol'
import { ScriptedBrain } from '../src/ai/ScriptedBrain'
import { Bot } from '../src/bot/Bot'
import { buildTextPacket, type TextPacket } from '../src/bot/packets'
import { defaultBotConfig } from '../src/config'
import { createLogger, setLogLevel } from '../src/logger'

const PORT = 19177
const TIMEOUT_MS = 30_000

async function main(): Promise<void> {
  setLogLevel('debug')
  const log = createLogger('smoke')

  // createServer() would start listening on its own; constructing Server directly lets us
  // await the bind (calling listen() twice binds the port twice and fails).
  // The native RakNet server fails to start on some Windows setups; the pure-JS one is fine
  // for a loopback test. The bot (client side) still uses its default backend.
  const serverOptions: ServerOptions = {
    host: '127.0.0.1',
    port: PORT,
    offline: true,
    raknetBackend: 'jsp-raknet',
    motd: { motd: 'GoodToBeKing loopback', levelName: 'smoke' },
  }
  const server = new bedrock.Server(serverOptions)

  const serverSawReply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the bot to reply')),
      TIMEOUT_MS
    )
    server.on('connect', (player) => {
      log.info('server: client connected')
      player.on('join', () => {
        log.info(`server: ${player.profile?.name} joined, sending play_status=player_spawn`)
        player.write('play_status', { status: 'player_spawn' })
        setTimeout(() => {
          log.info('server: Tester says "ping Merlin"')
          player.write('text', buildTextPacket('chat', 'Tester', 'ping Merlin'))
        }, 500)
      })
      // Player's typings only list a handful of events; packet events are untyped.
      ;(player as unknown as EventEmitter).on('text', (packet: TextPacket) => {
        log.info(`server: received text ${JSON.stringify(packet)}`)
        if (packet.type === 'chat' && packet.message.includes('pong')) {
          clearTimeout(timer)
          resolve(packet.message)
        }
      })
    })
  })

  await server.listen()
  log.info(`server listening on 127.0.0.1:${PORT}`)

  // jsp-raknet speaks RakNet protocol 10 and the native client speaks 11, so the bot must use
  // the same backend as the in-process server here.
  const cfg = {
    ...defaultBotConfig(),
    name: 'Merlin',
    server: { host: '127.0.0.1', port: PORT, raknetBackend: 'jsp-raknet' as const },
    auth: { offline: true, profilesFolder: '.auth-cache' },
    autoReconnect: false,
  }
  const brain = new ScriptedBrain({
    onChat: (event) => (event.message.toLowerCase().includes('ping') ? `pong ${event.from}` : null),
  })
  const bot = new Bot(cfg, brain, createLogger('bot'))

  await bot.connect()
  log.info(`bot spawned, status=${bot.state.status}`)

  const reply = await serverSawReply
  log.info(`PASS: server received "${reply}" from the bot`)

  await bot.disconnect()
  await server.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
