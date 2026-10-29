/**
 * Joins the server in .env as a temporary player, says each line (waiting half a minute for the
 * court's answers after each), prints everything said in chat, and leaves. Meant for a test
 * server, to talk to the court as a royal would:
 *   corepack pnpm exec tsx scripts/say-as.ts <player> "<line>" ["<line>" ...]
 */
import { createBot } from 'mineflayer-bedrock'
import { serverOptions } from '../src/bot/Bot'
import { defaultBotConfig } from '../src/config'
import { sleep } from '../src/util'

const ANSWER_MS = 30_000

async function main(): Promise<void> {
  const [player, ...lines] = process.argv.slice(2)
  if (!player || lines.length === 0) {
    console.error('usage: say-as.ts <player> "<line>" ["<line>" ...]')
    process.exit(1)
  }
  const body = createBot({
    ...serverOptions(defaultBotConfig().server),
    username: player,
    auth: 'offline',
    hideErrors: true,
  })
  const client = (body as unknown as { _client: NodeJS.EventEmitter })._client
  client.on('text', (p: { source_name?: string; message?: string }) => {
    if (p.source_name !== player)
      console.log(`${p.source_name ? `<${p.source_name}>` : '[server]'} ${p.message}`)
  })
  await new Promise<void>((resolve) => body.once('spawn', () => resolve()))
  await sleep(10_000) // the court's greetings first
  for (const line of lines) {
    console.log(`<${player}> ${line}`)
    body.chat(line)
    await sleep(ANSWER_MS)
  }
  body.quit()
  await sleep(2_000)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
