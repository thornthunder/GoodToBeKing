# The royal court: every bot and its brain, in one container next to the Ollama server.
#   docker compose up -d --build     (see compose.yaml and README.md)
FROM node:24-bookworm-slim

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && chown node:node /app
USER node

# Dependencies first (they change least): pnpm with bedboo's exact versions and patches.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node patches ./patches
COPY --chown=node:node vendor/bedboo ./vendor/bedboo
RUN corepack pnpm install --frozen-lockfile

COPY --chown=node:node tsconfig.json tsconfig.build.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node config ./config
RUN corepack pnpm run build && mkdir -p .state

# .state (memories, orders, works, magic) is a volume; config/court.json is mounted read-only.
VOLUME /app/.state
CMD ["node", "dist/index.js"]
