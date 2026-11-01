# The royal court: every bot and its brain, in one container next to the Ollama server.
#   docker compose up -d --build     (see compose.yaml and README.md)
# A second stage, admin, is the court's web admin (compose.admin.yaml).
FROM node:24-bookworm-slim AS court

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

# The admin: the court's code (its page is in src/admin/ui) with docker, compose and git, to run
# compose in the worlds' checkouts as one would on the host (the Docker socket is mounted).
FROM court AS admin
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates   && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
USER node
# The checkouts belong to the host's user (the same uid as node); git needs to trust them anyway.
RUN git config --global --add safe.directory '*'
ENV ADMIN_DATA=/data
EXPOSE 8080
CMD ["node", "dist/admin/main.js"]
