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
patchedDependencies (patch paths point into `vendor/bedboo/patches`). Our own patch,
`patches/minecraft-data@3.117.0.patch`, stands in for Bedrock 1.26.60 support (see the protocol
notes); drop it once bedboo supports the server's version.

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

Building tools (each joins the real server as a temporary player, `Surveyor` or the bot named;
the court ignores the name `Surveyor`, see `IGNORE_PLAYERS`):

```bash
corepack pnpm exec tsx scripts/plan-castle.ts config/castles/great-castle.json 73 74   # compile a design, list sections, print storey maps
corepack pnpm exec tsx scripts/works-one.ts <design> <section id> [bot]                 # build one section with one bot
corepack pnpm exec tsx scripts/check-section.ts <design> [section id prefix ...]         # what is not as planned, and what stands there instead
corepack pnpm exec tsx scripts/survey-terrain.ts x1 z1 x2 z2 [baseY] [types] [json=f]    # height or block-type map of an area
corepack pnpm exec tsx scripts/overlord-plan.ts <terrain.json> <out.json> [model]        # let the overlord design a castle offline
corepack pnpm exec tsx scripts/render-castle.ts <design.json> <out.png> [scale]          # picture of each storey from above
corepack pnpm exec tsx scripts/make-court-skins.ts [preview-dir]                         # repaint the court's skins (config/skins)
```

### Commands to a running app

Write a line to a file named `.command` in the project root (checked every second):
`<bot> build <blueprint> x y z [for <player>]`, `<bot> resume <blueprint> x y z [turns N]`,
`<bot> commission <blueprint> [at x y z] [for <player>]` (as if a royal asked that bot: the
Castellan hands it to a builder), `<bot> undo`, and for the court's building works `works status|pause|resume`,
`works start <design.json>` and `works plan` (the overlord designs the next castle now). For
magic: `Merlin cast <spell> [on <who>] [to <place>] [item <x>] [creature <x>] [for <player>]`,
`Merlin spells` (logs spells, places and gifts still to fade), `Merlin fade` (takes every gift
back now) and, as a developer tool, `Merlin run <command>` (a raw command as Merlin; only this
machine writes the command file).

### Docker (the court VM)

The court runs on a Linux VM next to the game server (every block placed waits for one round
trip to the server: 172 ms from the family's LAN, 0.3 ms from there); Ollama stays on Ava, across
the VPN. Deploy: `git push court-vm main` (a remote on the dev PC; the VM's checkout takes pushes
with `receive.denyCurrentBranch updateInstead`), then on the VM `git submodule update --init &&
docker compose up -d --build`. Only one court may run at a time.
`Dockerfile` + `compose.yaml`: host networking,
`.env` as env file, `.state` and `config/court.json` mounted, `COMMAND_FILE=.state/.command`,
`docker compose stop` sends SIGTERM (handled like `.stop`; grace 60 s). Paths stored in `.state`
must be portable: `court-works.json` written on Windows had backslashes (`courtWorks()` turns
them into `/`).

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
- `ai/CourtMemory.ts`: each bot's own long-term memory, facts per subject (royals and
  courtiers, up to 400 each) in `.state/memory-<bot>.json`. Bots never read each other's
  memory: a bot remembers only what it heard (`BrainContext.hears`: whispered to it, its turn to
  answer, named in the line, or said within `EARSHOT` 24 blocks), so one can keep a secret and
  news travels by being said where others hear it. A bot notes royal lines it hears and, while a
  royal is talking, the other courtiers' lines (`Brain.onCourtLine`), and writes each
  conversation down once it pauses for 15 s (at most 90 s), in the background, with
  `OLLAMA_MEMORY_MODEL` and a JSON schema, from its own point of view. The family asked for as
  much as possible, real life included: real-life facts are kept as `private` (model flag or
  `isPersonalInfo`) and go into a prompt only while nobody but the royal family is online;
  `secret` facts (whispered, or asked to be kept) are marked never to be told; secrets it only
  overheard are not written down; `isSecret` (passwords, PINs, logins) is never stored. Prompts
  show each subject's latest facts plus older ones sharing words with the talk (`recall`).
  Whispers are answered by whisper (`Bot.whisper`, `/tell` needs no operator rights). The memory model
  is the overlord's gemma4:31b, asked for as shared (`ChatOptions.shared`), with a 10 minute
  timeout for a cold load; if it does not answer, the chat model extracts.
- `bot/language.ts`: Bedrock language strings from minecraft-data; translates notice keys and
  keys inside parameters ("%entity.zombie.name"). `OllamaBrain.onNotice` reacts to royal
  deaths, sleeping and achievements with a per-person cooldown.
- `ai/riddles.ts`: the riddle book. Small models invent riddles whose hints and answers do
  not fit, so bots only tell riddles from this list; the open riddle and its answer sit in the
  system prompt until it is guessed, given up or 15 minutes pass.
- `ai/orders.ts`: the court's laws (`COURT_LAWS`, above every order), each bot's standing
  orders (`OrderBook`, `.state/orders-<bot>.json`) and the royals' rules for the whole court
  (`CourtRules`, `.state/rules.json`). `OllamaBrain.orderTurn` reads every royal line meant for
  the bot (it answers, it is named, or a call to everyone) with `OLLAMA_ORDER_MODEL` (gemma4:31b,
  15 s, else the chat model) into a `Reading`: order, rule, release or none, and what it clashes
  with. `judge`: a law clash is declined; the King is asked to confirm a clash ("yes"/"no" within
  5 min); a clash with an order from someone higher is declined with the reason; otherwise the
  newest wins. Follow and stay orders are posts: no building works or escort duty while they
  stand; `Bot.tick` keeps following, and a follow order ends when its target leaves. A bot with
  `reportsTo` owes a report on every royal order and gives it when its superior is within earshot.
- `magic/`: Merlin's magic. `spells.ts` holds the building blocks (teleport, effect, weather,
  time, summon, particle, sound, give, saddle) with their allowlists, the built-in spells and
  `commandsFor`, which writes the commands; the model only picks a spell and its target, place,
  item or creature (in the order reading), and nothing it writes is run. `Magic.ts` keeps learned
  spells and gifts in `.state/magic-<bot>.json`, cooldowns (teleports none, effects 2 min,
  weather, time and gifts 10 min, creatures 5 min, sparkles 30 s), and takes gifts back after a
  day (`clear`, or the saddle off the horse it tagged). `places.ts` names a free spot in every
  room of the castles built and being built. Spells only for royals and courtiers, never on a
  royal who outranks the one asking; only the King teaches a spell, and Merlin learns it after
  repeating it back and a "yes". `Bot.command` sends a command and waits for `command_output`.
  One request can hold up to three spells, cast in order ("take us both to the castle and gather
  the court" = portal, portal, gather). A taught spell is tidied first (`tidySteps`: one thing per
  step, missing whom = the target).
- Bedrock horses: a saddle can only go on a tame horse ("commands.generic.exception" otherwise);
  `replaceitem ... slot.saddle 0 saddle` puts it on, but the saddle then lives in
  `slot.inventory 0`, and the horse stays saddled until `event entity ... minecraft:horse_unsaddled`.
  Emptying `slot.saddle` reports success and changes nothing; `hasitem` with
  `location=slot.saddle` is unreliable, `hasitem={item=saddle,quantity=0}` works. Check a
  horse's real state from a client: the `saddled` and `tamed` flags in its entity metadata.
- `bot/ChatFloor.ts`: one bot answers each line (the one named, the one already talking with that
  player, or the herald: the first bot online, the Castellan first for guests). Only the herald
  hails and reacts to notices. Guards with `duty: escort` follow their royal when one is in sight.

### The court's building works

- The court is `config/bots.json` (Merlin, Festaris the Castellan, guards Bruce and Dyke,
  apprentices Henry and George); `works: true` puts a bot in the building crew.
  Chain of command (`reportsTo`): the royal family outranks everyone; Merlin and Festaris answer
  to the royals alone; Bruce, Dyke, Henry and George report to Festaris. Each prompt states the
  bot's place (`chainOfCommand`), and the Castellan gives building tasks only to his own staff
  (Merlin picks his part himself and tells the court).
- `build/design.ts`: the castle design language (area, curtain wall, gates, towers, buildings with
  storeys of typed rooms, features). Coordinates are relative to the area's north-west corner;
  rooms include their walls and share wall lines. `validateDesign` explains problems in plain
  sentences (they are fed back to the overlord). `config/castles/great-castle.json` is the first.
- `build/compile.ts`: design -> Plan of sections (work orders). Draws into one block map where
  later drawings win (courtyard, curtain wall, towers, buildings, features), splits sections over
  `MAX_SECTION_CELLS` along their long axis, and gives each ground section its columns: natural
  blocks above the floor are cleared, gaps below are filled down to the ground. `existing` builds
  (Merlin's first castle) are kept and only repaired (foundations, a back gate).
- `build/rooms.ts`: furniture per room type, from plain blocks. Directional blocks carry `from`,
  the side the builder stands on (beds: head away from it; chests and furnaces face it); ladders
  carry `against`.
- `build/Mason.ts`: builds one section by creative flight: clears natural blocks top down
  (`NATURAL`; never anything players made, except `remove` cells), fills, then places bottom
  layer first, hovering above the layer so it is never shut in under a ceiling. Cells where a
  player-made block stands (the village path) are counted as `blocked`, not missing. It also
  raises the small blueprints (`Bot.startBuild`: fly over with `visit`, `findSite` on
  `mason.world()`, one job; the blocks it placed go to the build log for "take it down", which
  is a job of `remove` cells). The old walking builder could not reach ground-level blocks.
- `build/Commissions.ts`: the builds royals ask for (`.state/commissions.json`). A builder asked
  directly builds at once (`own`); the Castellan (no `canBuild`, builders reporting to him)
  takes the request and `BotManager.assignCommissions` hands it to his nearest free builder,
  with a line each way, before any castle section. Each courtier who took or builds one has its
  true state in its prompt (`describeCommission`), and one not listed was never started, so
  nobody invents progress. Cut short: waits again; incomplete or unreachable: 3 tries; no flat
  ground: failed. Builds go wherever the royal stood, anywhere (no build zone).
- Great works: "build a palace / a new castle here" (or "at x y z", `detectWorksRequest`) to the
  Castellan becomes a `works` action; `BotManager.orderWorks` has the overlord design it within
  48 blocks of that spot (`planNextCastle(ordered)`), or queues it in `court-works.json`
  (`ordered`) until the castle in hand is finished.
- `build/Works.ts`: hands free workers the next ready section (prerequisites done, own crew
  first, nearest of the first few), retries incomplete sections (3 tries), keeps state in
  `.state/works-<plan>.json`, and gives incomplete sections one more try after a restart.
  `BotManager` runs it every 5 s and turns its events into work talk: the Castellan assigns, the
  worker answers (at most one exchange per 40 s, none within 90 s of a royal speaking).
- `build/sites.ts` + `ai/Overlord.ts`: when the castle is finished and `WORKS_NEXT=overlord`, the
  bots survey what they can see for open natural ground (8 blocks clear of anything players
  made), the overlord model (`OVERLORD_MODEL`, gemma4:31b) picks a site and writes a design,
  which is validated and sent back with every problem until sound (6 rounds). The design is
  saved in `.state/designs/` and `.state/court-works.json` records what was built and what is
  current. The overlord streams its answers and asks for its model as shared (`overlordClient`). Rooms it counts
  from their building's own corner are read as meant (`normaliseRooms`); `courtProblems` adds
  a builder's review (rooms that fill their storeys, halls big enough, stables on the ground).

- Thinking aloud: when a royal's answer is not ready after 2.5 s (the line is read by the big
  model first), the bot says one of its `chat.thinking` lines (bots.json; at most one a minute,
  by whisper for a whisper, kept out of the history).
- Silence guard: when a royal names the bot (even misspelled, `mentionsNameLoosely`) or answers
  the bot's last line and the model replies `[silent]`, `generate` asks once more with a note.
- `CourtMemory` re-reads its file when the mtime changes, so hand edits are safe while running.
- `.state/` holds runtime state that survives restarts; it is git-ignored.

## Project constraints

- The bots must work **without operator rights**: no `/tp`, `/fill`, `/setblock`, `/give`.
  Movement and building have to be done through player-level packets. The one exception, by the
  family's choice, is Merlin's magic (`magic: true`): Merlin is an operator by name (`op Merlin`
  in the server console; the world has `allow-cheats=true`), and only the spells in
  `src/magic/spells.ts` ever run commands, built by code from allowlists. Offline players have
  no account id, so the server cannot keep operator rights on disk ("Missing id, won't persist
  permissions on disk") and Merlin loses them on every reconnect; a client-sent XUID is ignored.
  `server/start-bds.cmd` (+ `.ps1`) runs the server and types `op Merlin` whenever he spawns.
  Merlin checks his rights (`execute as @s run testfor @s`) after each spawn and every minute while they are
  missing; until then his magic sleeps and he says so in character.
- The court's own choices (the overlord picking a site by itself) stay within `BUILD_RADIUS`
  (100) of `BUILD_CENTER` (105, 75, 122). What a royal asks for is built where they say,
  anywhere (the King's wish, 2026-10-28). Never dig player-made blocks: the princess's house and
  the village paths lie south of the castle.
- Requests to a shared model take turns inside this program (`ModelQueue` in OllamaClient):
  reading a royal's line is urgent and cuts a memory extraction short (it reruns afterwards), the
  overlord is normal. Ollama serves its own queue in arrival order, so without this a royal waited
  behind every extraction the court had started.
- The court shares one Ollama server (48 GB of VRAM) with another program. The court loads only
  two models: gemma4:e4b for chat (`keep_alive` 24h) and gemma4:31b for memory and the
  overlord, which the other program uses now and then. gemma4:31b with the server's defaults
  (context 262144) takes 20.5 GB, all on the GPU, 32 tokens/s. Shared requests use the context
  it is loaded with (none when it is not loaded) and never shorten its keep-alive: another
  `num_ctx` reloads it (once half on the CPU at 5 tokens/s) and pushes the other's copy out.
  Never unload it, and do not add a third model.

## Protocol notes (bedrock-protocol 3.60, Bedrock 1.26.x)

- The server runs Bedrock 1.26.60 (protocol 2225). mineflayer-bedrock accepts only the version
  `1.26.51`, so `patches/minecraft-data@3.117.0.patch` puts the 1.26.60 protocol under that label
  (and the number 2225). The schema is minecraft-data's `bedrock_1_26_60` branch (commit
  6b31d379), checked field by field against Mojang's bedrock-protocol-docs (1.26.50 -> 1.26.60)
  and gophertunnel's 1.26.60 support. The login still says `GameVersion` 1.26.51; the server
  accepts it.
- 1.26.60 servers answer only on Nethernet: no RakNet ping, no RakNet connection (bedboo:
  "Mojang announced its removal"). `MC_TRANSPORT=nethernet` connects over WebRTC with HTTP
  signalling on the game port. A spawn then takes 15-30 s when several bots join at once, so the
  offline spawn timeout is 90 s.
- nethernet's default WebRTC is werift, pure JS: DTLS and SCTP for every packet run on our one
  thread. Six bots kept it 94% busy (profile: crypto, buffers and GC about half); then chat
  arrives a minute late, `request_ability` answers miss bedboo's flight-confirm window ("flight
  stopped") and the server pulls flying bots back. `MC_WEBRTC=wrtc` selects the native
  `@roamhq/wrtc` backend (a dependency now; `auto` falls back to werift when it will not load).
- The next cost was mobs' `set_entity_data` (80 a second per bot around the village; protodef
  builds an object of every flag): `Bot` drops it unread for anything but itself and players
  (`metadataTarget`). With both, six idle bots leave the thread about 30% idle.
- mineflayer-bedrock always asks for version `1.26.51`; `MC_VERSION` only matters for other
  clients.
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

## Building notes

- Creative stacks must not exceed the item's stack size: a stack of 64 beds or cakes is refused
  with "item stack request rejected (status 51)". The mason asks for `stackSize`.
- A creative entry is matched by item and metadata: bed colours are the bed item's data value.
- Node's fetch gives up after five minutes without response headers; long model answers must be
  streamed (`ChatOptions.stream`).
- With bash in this environment, `a && b && c &` backgrounds the whole chain.

## Conventions

- Prettier: no semicolons, single quotes, width 100. ESLint flat config in `eslint.config.mjs`.
- Source files are UTF-8; literal special characters such as the section sign, ellipsis and
  curly quotes are fine. The editing tools in this environment turn unicode escape sequences
  into literal characters anyway.
- Log through the `Logger` passed into each class; child loggers are named per bot.
- Secrets and auth caches never go in git (`.env`, `.auth-cache/`).
- Prefer adding a packet type to `packets.ts` over `any`-typed handlers.
