# CLAUDE.md

Guidance for working in this repository.

## What this is

GoodToBeKing runs AI-controlled players on a Minecraft **Bedrock** server. Each bot's body is a
mineflayer-bedrock bot (from the `vendor/bedboo` git submodule, LGPL-3.0, pinned to a reviewed
commit) whose bedrock-protocol client we also listen to directly; an Ollama model (at
`OLLAMA_HOST`, by default `http://ava:11434`) decides what the bot says and does. TypeScript,
CommonJS output, Node 24+.

## Commands

Always use pnpm (`corepack pnpm ...`), never npm: mineflayer-bedrock needs the exact versions
and patches in `pnpm-workspace.yaml`, which mirrors `vendor/bedboo/pnpm-workspace.yaml`. After
bumping the submodule, re-copy its overrides / packageExtensions / allowBuilds /
patchedDependencies (patch paths point into `vendor/bedboo/patches`).

```bash
corepack pnpm install
corepack pnpm run dev            # run from source (tsx)
corepack pnpm run check          # typecheck + lint + unit tests; run before finishing any change
corepack pnpm run smoke          # loopback end-to-end: in-process server + bot + scripted brain
corepack pnpm run live:follow    # real server: two temporary bots test follow and stop (visible!)
corepack pnpm run ollama:check   # verifies the model server and does one chat
```

The loopback smoke test covers connect, spawn and chat. Walking needs a real world, so it is
covered by `live:follow`, which joins the real server from `.env`. vitest only runs `src/`
tests (bedboo has its own mocha suite).

### Stopping a running app

Create a file named `.stop` in the project root. The app checks for it every second, sends
every bot a proper disconnect, deletes the file and exits. Use this instead of killing the
process: a hard kill leaves the bot's session on the server, and a restarted bot with the same
name is kicked with `server_id_conflict` until that session times out (30 to 60 seconds). On
Windows, killing a background `npx` shell does not kill its node children at all.

## Architecture (src/)

- `config.ts`: all settings come from env (`.env` auto-loaded) and optionally `BOTS_FILE`
  (JSON array of partial `BotConfig` overrides merged section by section).
- `bot/Bot.ts`: one player. Creates a mineflayer-bedrock bot (`body`) and attaches our packet
  handlers to `body._client`. Keeps a small `BotState` (status, runtime id, position, health,
  players by UUID), chat send/receive, `runCommand`, `act()` for brain actions, auto-reconnect
  with backoff. Emits `spawn`, `chat`, `close`. Never emits `error` (an unhandled `error` event
  would throw); the body's `error` event is logged at debug level.
- `bot/movement.ts`: follow / come / stop on mineflayer-pathfinder. Movements are configured to
  never change the world: `canDig=false`, `allow1by1towers=false`, no scaffolding blocks,
  `canOpenDoors=false`. Keep it that way unless the user asks.
- The brain returns `BrainReply { say, action? }` from `onChat`; actions are follow/come/stop,
  only for royals, and only toward a player the bot can see (a known distance in the context).
- `bot/packets.ts`: the packet field shapes we rely on plus `buildTextPacket`,
  `parseTextPacket`, `normalisePlayerList`. Keep protocol knowledge here, not in Bot.ts.
- `ai/Brain.ts`: the interface between the connection and the decision making. A brain gets
  events plus a `BrainContext` snapshot and returns text or null. `OllamaBrain` is the real
  one, `ScriptedBrain` is for tests.
- `ai/OllamaClient.ts`: single place that talks to Ollama. Adds per-request timeout via a
  custom fetch, and auto-disables thinking on thinking-capable models (9s vs 0.3s per reply).
- `bot/BotManager.ts`: creates one `OllamaClient` + `OllamaBrain` + `Bot` per config entry,
  connects them with a stagger. Passes all bot names to each Bot so bots ignore each other.
- `court.ts`: the royal roster (`config/court.json`, git-ignored; example file is tracked).
  `CourtRoster` does case-insensitive lookup, prompt labels and the court prompt section.
- `OllamaBrain` hails royals on join (after a 4s delay in Bot) and on spawn, answers royals
  without a name mention, serialises inference through a promise queue, and falls back to a
  fixed hail if the model fails. Its safety rules are hard-coded on purpose: the princess is a
  child. It must not claim to move or build until those abilities exist.
- `ai/abilities.ts`: detects requests for things the bots cannot do yet (follow, build, fetch),
  adds a one-off note next to the request, and replaces replies that promise them anyway.
  Remove an ability from this file when it becomes real.
- `ai/HailLog.ts`: last hail time per player, file-backed in `.state/<bot>.hails.json`.
- `ai/CourtMemory.ts`: long-term facts per subject in `.state/memory.json`, shared by all bots.
  Only the first bot (`learns: true`) extracts facts, after each royal exchange, in the
  background, using `OLLAMA_MEMORY_MODEL` with a JSON schema. `isPersonalInfo` drops
  real-world personal details in code regardless of what the model returns.
- `bot/language.ts`: Bedrock language strings from minecraft-data; translates notice keys and
  keys inside parameters ("%entity.zombie.name"). `OllamaBrain.onNotice` reacts to royal
  deaths, sleeping and achievements with a per-person cooldown.
- `ai/riddles.ts`: the riddle book. Small models invent riddles whose hints and answers do
  not fit, so bots only tell riddles from this list; the open riddle and its answer sit in the
  system prompt until it is guessed, given up or 15 minutes pass.
- Silence guard: when a royal names the bot (even misspelled, `mentionsNameLoosely`) or answers
  the bot's last line and the model replies `[silent]`, `generate` asks once more with a note.
- `CourtMemory` re-reads its file when the mtime changes, so hand edits are safe while running.
- `.state/` holds runtime state that survives restarts; it is git-ignored.

## Project constraints

- The bots must work **without operator rights**: no `/tp`, `/fill`, `/setblock`, `/give`.
  Movement and building have to be done through player-level packets.

## Protocol notes (bedrock-protocol 3.60, Bedrock 1.26.x)

- The protocol version is auto-detected from the server ping; `MC_VERSION` forces one.
- `text` packet gained a `category` field (`message_only` | `authored` | `parameters`) in
  1.26. Outgoing chat uses `category: 'authored'`; older serializers ignore unknown fields.
  Required outgoing fields: `type, needs_translation, category, source_name, message, xuid,
platform_chat_id, has_filtered_message, filtered_message`.
- `player_list.records` is a flat array of `{ type: 'add'|'remove', uuid, username, ... }`
  in 1.26; before that it was `{ type, records: [...] }`. `normalisePlayerList` handles both.
- `command_request` on 1.21.130+ needs `origin.player_entity_id` (bigint) and
  `version: 'latest'`. Getting it wrong yields a misleading "Command exceeds maximum size"
  packet violation.
- Client events in order: `connect_allowed`, `join` (after encryption handshake), `spawn`
  (on `play_status: player_spawn`). `close` removes all listeners; re-attach on reconnect.
- `start_game.player_position` has a placeholder height (y ~ 32769). The real spawn point
  arrives in `respawn` with `state === 1`, before `spawn` fires.
- `player_list` records carry `entity_unique_id`; `add_player` carries both `unique_id` and
  `runtime_id`. They are different numbers. `move_player` uses the runtime id;
  `remove_entity.entity_id_self` uses the unique id (player left render distance).
- Players in `player_list` before our own spawn were already online; adds after spawn are
  joins.
- If a bot process dies without disconnecting, the server keeps its session for a while and
  a new bot with the same name is kicked with `server_id_conflict` until it times out.
- The in-process server used by the smoke test only sends `play_status: player_spawn`; the
  client then has no `start_game`, so `state.position` stays undefined there.
- `createServer()` starts listening by itself; calling `listen()` on it again binds the port
  twice and fails. The smoke test constructs `new bedrock.Server()` and awaits `listen()`.
- The `raknet-native` _server_ fails to start on the Windows dev machine ("Server failed to
  start" on every port) while the native _client_ works. `jsp-raknet` only speaks RakNet
  protocol 10 and the native backend speaks 11 for 1.19.30+, so the smoke test runs
  jsp-raknet on both sides. Real servers need the native client (`MC_RAKNET_BACKEND` empty).

## Conventions

- Prettier: no semicolons, single quotes, width 100. ESLint flat config in `eslint.config.mjs`.
- Source files are UTF-8; literal special characters such as the section sign, ellipsis and
  curly quotes are fine. The editing tools in this environment turn unicode escape sequences
  into literal characters anyway.
- Log through the `Logger` passed into each class; child loggers are named per bot.
- Secrets and auth caches never go in git (`.env`, `.auth-cache/`).
- Prefer adding a packet type to `packets.ts` over `any`-typed handlers.
