# GoodToBeKing

AI-driven players for Minecraft Bedrock. Each bot logs into a standard Bedrock server as a
regular player and takes part in the game, with an [Ollama](https://ollama.com) model as its brain.

Current state: bots join a server, know the royal court, chat through the model, remember what
the royals tell them, and walk: they follow a royal, come when called, and stop when asked.
Building and other in-world actions are the next milestones.

## Requirements

- Node.js 24 or newer on x64 (the RakNet transport ships x64 prebuilds only)
- pnpm through corepack (bundled with Node; the version is pinned in `package.json`)
- A Bedrock Dedicated Server 1.26.60 to join (over Nethernet: `MC_TRANSPORT=nethernet`)
- An Ollama server with at least one chat model pulled

## Quick start

```bash
git clone --recurse-submodules <this repo>   # or: git submodule update --init
corepack pnpm install
cp .env.example .env     # then edit MC_HOST / MC_PORT / OLLAMA_HOST / OLLAMA_MODEL
cp config/court.example.json config/court.json   # then put in the real player names
corepack pnpm run ollama:check   # is the model server reachable and does the model answer?
corepack pnpm run smoke          # loopback test: in-process Bedrock server + bot, no model needed
corepack pnpm run dev            # start the bot(s)
```

Use pnpm, not npm: the bots' body comes from the bedboo submodule, which only works with the
pinned versions and dependency patches in `pnpm-workspace.yaml`.

Once a bot is in the world, say its name in chat (for example "hey Merlin") or whisper to it and
it will answer. Set `BOT_RESPOND_TO_ALL=true` to make it react to every chat line.

## Walking

The bots' bodies come from [mineflayer-bedrock](https://github.com/LiteLDev/bedboo) (the
`vendor/bedboo` submodule, LGPL-3.0): Bedrock physics, the world around the bot, and
mineflayer-pathfinder. Royals can say, in their own words:

- "Merlin, follow me": the bot walks after them until told to stop.
- "Merlin, come here": the bot walks over to where they are.
- "Stop" / "wait" / "stay" while it is walking: it stops.

The bot only moves for the royal family, only toward someone it can see, and never changes the
world while walking: it does not dig through blocks, place blocks, build pillars or bridges.
It cannot open doors yet. If someone is out of sight it says so instead of promising to come.

## The royal court

The bots serve a royal family defined in `config/court.json`. Copy
[config/court.example.json](config/court.example.json) and put in the real player names. The
real file is git-ignored because it holds family gamertags.

- Each member has a player name, a title such as Princess or King, a form of address such as
  "Your Highness", and optional notes for the bots.
- When a royal joins, every bot hails them by title a few seconds later. If royals are already
  online when a bot spawns, the bot hails them instead of saying its normal greeting.
- Bots answer every chat line from a royal, without needing their name
  (`BOT_RESPOND_TO_ROYALS`). Other players are guests: welcomed on join (`BOT_GREET_VISITORS`)
  and answered when they address the bot by name.
- The same player is not hailed twice within ten minutes, so a reconnect does not cause spam.
  Hail times are kept in `.state/`, so a restarted bot says it is back instead of hailing again.
- Fixed safety rules are always in the prompt: child-appropriate content only, no requests for
  personal information, no suggestions to talk outside the game.
- Requests the bots cannot fulfil yet (follow, build, fetch) are detected; the bot declines in
  character, and a reply that promises the impossible anyway is replaced.
- Server notices are translated with the Bedrock language strings. When a royal dies, falls
  asleep or earns an achievement, the bot comforts, says goodnight or congratulates.

### Memory

After each exchange with a royal, the first bot (the court's scribe) asks a model, in the
background, which lasting facts the exchange revealed: favourite things, wishes, names given to
pets and places, what the bot promised. Facts are stored per person in `.state/memory.json`
(git-ignored), shared by every bot, and shown in each bot's prompt. You can read or edit that
file by hand, even while the bots are running: they reload it when it changes.

Real-world personal information (age, school, address, real names and the like) is never
stored: the extraction prompt forbids it and a filter in code drops anything that slips through.
`OLLAMA_MEMORY_MODEL` picks the extraction model (default `gemma4:12b`); it never delays a reply.

## Authentication

- `MC_OFFLINE=true` (default): no Microsoft account. The server must run with
  `online-mode=false`. The bot's name is whatever `BOT_NAME` says.
- `MC_OFFLINE=false`: sign in with a Microsoft account. On first start the log prints a
  device-code URL and code; sign in once and the token is cached in `MC_PROFILES_FOLDER`.
  The bot appears under that account's gamertag. Each bot needs its own account.

## Configuration

Everything is read from environment variables (`.env` is loaded automatically).
See [.env.example](.env.example) for the full list with comments. The important ones:

| Variable             | Default              | Meaning                                                             |
| -------------------- | -------------------- | ------------------------------------------------------------------- |
| `MC_HOST`, `MC_PORT` | `127.0.0.1`, `19132` | Server to join                                                      |
| `MC_VERSION`         | auto                 | Force a protocol version instead of detecting it                    |
| `MC_OFFLINE`         | `true`               | Skip Microsoft login                                                |
| `BOT_NAME`           | `Merlin`             | Display name (offline mode only)                                    |
| `BOT_PERSONA`        | built-in             | How the bot should behave, in plain English                         |
| `BOT_RESPOND_TO_ALL` | `false`              | Reply to everything, not just mentions                              |
| `OLLAMA_HOST`        | `http://ava:11434`   | Ollama API base URL                                                 |
| `OLLAMA_MODEL`       | `gemma4:e4b`         | Chat model                                                          |
| `OLLAMA_THINK`       | auto                 | Thinking is disabled on models that support it; set `true` to allow |
| `BOTS_FILE`          | unset                | JSON array of per-bot overrides for running several bots            |
| `COURT_FILE`         | `config/court.json`  | Royal court roster                                                  |

### Several bots

Point `BOTS_FILE` at a JSON file like [config/bots.example.json](config/bots.example.json).
Each entry starts from the environment defaults and overrides only the keys it sets, so two bots
can share a server and model but differ in name, persona or temperature. Bots connect one after
another with a short stagger.

The court in [config/bots.json](config/bots.json) has six members: Merlin the court wizard,
Festaris the Castellan (in charge when the royals are away), the royal guards Bruce and Dyke
(they escort the Princess and the King when they are in sight), and the Castellan's apprentices
Henry and George. One of them answers each chat line: the one named, the one already talking
with that player, or the herald.

## Building together

The court builds castles as a crew. A castle is written in a small JSON design language
(walls, gates, towers, buildings with storeys of typed rooms, courtyard features); see
[config/castles/great-castle.json](config/castles/great-castle.json) and `src/build/design.ts`.
Set `WORKS_DESIGN` to a design and the app compiles it into furnished blocks and work orders.

- The Castellan hands out the work orders in chat and the crew answers him; every free bot
  takes the next order whose prerequisites are done (upper storeys wait for the ones below).
- Bots build like creative-mode players, no operator commands: they clear natural terrain off
  the site, fill foundations, and fly to place every block. They never break anything a player
  made; the village path under the stables is simply left in place.
- Progress is kept in `.state/`, so a restart carries on where it stopped; incomplete work
  orders are retried, rooms already roofed over are reached through a gap in the roof that is
  closed again afterwards.
- With `WORKS_NEXT=overlord`, once the castle is finished the court plans the next one on its
  own: the bots survey open ground, a larger model (`OVERLORD_MODEL`) picks a site and writes a
  design, and every problem the builders find is sent back until the design is sound.

`.command` lines control the works while the app runs: `works status`, `works pause`,
`works resume`, `works start <design.json>` and `works plan`.

## Scripts

Run each with `corepack pnpm run <name>`.

| Script                        | What it does                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `dev`                         | Run from TypeScript sources with tsx                                                              |
| `build` / `start`             | Compile to `dist/` and run the compiled app                                                       |
| `smoke`                       | Loopback test: starts a bedrock-protocol server in-process, connects a bot, checks chat both ways |
| `live:follow`                 | Live test on the real server: two temporary bots check that "follow me" and "stop" work (visible) |
| `ollama:check`                | Lists models on the Ollama server and does one test chat                                          |
| `test`                        | Unit tests (vitest)                                                                               |
| `typecheck`, `lint`, `format` | TypeScript, ESLint, Prettier                                                                      |
| `check`                       | typecheck + lint + test                                                                           |

To stop a running app cleanly, create a file named `.stop` in the project root.

## Project layout

```
src/
  index.ts            entrypoint: load config, preflight Ollama, start bots, handle shutdown
  config.ts           env + BOTS_FILE -> AppConfig / BotConfig
  logger.ts           tiny leveled logger
  court.ts            the royal court roster
  ai/
    Brain.ts          Brain interface: events in, words and actions out
    OllamaBrain.ts    the court brain: hails, chat, riddles, movement requests, memory
    OllamaClient.ts   wrapper around the ollama package: timeouts, thinking auto-off, health
    abilities.ts      movement commands, and requests the bots cannot fulfil yet
    CourtMemory.ts    long-term facts per royal, shared by all bots
    HailLog.ts        when each royal was last hailed (survives restarts)
    riddles.ts        the riddle book
    ScriptedBrain.ts  deterministic brain for tests
    text.ts           reply cleanup, name matching, chat-length splitting
  bot/
    Bot.ts            one player: mineflayer-bedrock body, world state, chat routing, reconnect
    movement.ts       follow / come / stop on mineflayer-pathfinder, never changing the world
    BotManager.ts     builds and supervises all configured bots
    packets.ts        packet shapes we consume and helpers to build/parse text packets
    language.ts       Bedrock language strings for server notices
scripts/
  smoke-loopback.ts   end-to-end chat test without a real server
  live-follow.ts      end-to-end walking test on the real server
  ollama-check.ts     model server check
config/
  court.example.json  example royal court (copy to court.json)
  bots.example.json   example multi-bot override file
vendor/bedboo/        git submodule: mineflayer-bedrock (LGPL-3.0)
```

## How a bot works

1. `Bot.connect()` creates a mineflayer-bedrock bot (its body: physics, world, pathfinding) and
   hooks our own packet handling onto its bedrock-protocol client. It resolves once the server
   lets the player spawn.
2. Incoming `text` packets are normalised into `ChatEvent`s. Player chat that is not the bot's
   own is handed to the `Brain`; joins and server notices go to it too.
3. `OllamaBrain` keeps the last N chat lines, decides whether the line deserves an answer,
   detects movement requests and riddle turns, asks the model with a note about what is
   happening, cleans the reply and returns words plus an optional action (follow, come, stop).
   Only one inference runs at a time per bot; memory extraction runs in the background.
4. The bot says the words and hands the action to `Movement`.
5. If the connection drops the bot reconnects with exponential backoff.

## Roadmap

- Outfits for the new court members (only Merlin has a skin so far)
- Following flying players (creative flight), opening doors
- Doors, stairs and banners in the castle designs
- Tool-calling so the model can choose actions itself
- World awareness: nearby blocks, mobs and items in the prompt
