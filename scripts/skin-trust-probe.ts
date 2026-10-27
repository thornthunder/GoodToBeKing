/**
 * Joins as "SkinTest" wearing Merlin's skin with the given TrustedSkin claim, then lists the
 * trust flag the server assigns to every player's skin. Used to find out whether the server
 * will treat a custom skin as trusted.
 *
 *   tsx scripts/skin-trust-probe.ts [true|false]
 */
import bedrock from 'bedrock-protocol'
import { loadSkin } from '../src/bot/skin'
import { defaultBotConfig } from '../src/config'

const claim = process.argv[2] !== 'false'
const cfg = defaultBotConfig()
if (!cfg.skin) throw new Error('BOT_SKIN is not set')
const skinData = { ...loadSkin(cfg.skin, 'SkinTest'), TrustedSkin: claim }

const client = bedrock.createClient({
  host: cfg.server.host,
  port: cfg.server.port,
  username: 'SkinTest',
  offline: true,
  conLog: null,
  version: '1.26.51',
  skipPing: true,
  skinData,
} as Parameters<typeof bedrock.createClient>[0])

const done = (code: number) => {
  try {
    ;(client as unknown as { disconnect(reason: string): void }).disconnect('probe done')
  } catch {
    // already closed
  }
  setTimeout(() => process.exit(code), 500)
}

let timer: NodeJS.Timeout | undefined
;(client as unknown as NodeJS.EventEmitter).on(
  'player_list',
  (p: {
    records: Array<Record<string, unknown>> | { records?: Array<Record<string, unknown>> }
  }) => {
    const records = Array.isArray(p.records) ? p.records : (p.records.records ?? [])
    for (const r of records) {
      const skin = (r.skin_data ?? {}) as Record<string, unknown>
      if (r.username)
        console.log(`${String(r.username).padEnd(16)} trusted=${JSON.stringify(skin.trusted)}`)
    }
    timer ??= setTimeout(() => done(0), 5_000)
  }
)
;(client as unknown as NodeJS.EventEmitter).on('error', (e: Error) => {
  console.log('error', e.message)
  done(1)
})
setTimeout(() => done(2), 30_000)
console.log(`claiming TrustedSkin=${claim}`)
