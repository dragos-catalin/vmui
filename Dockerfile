# syntax=docker/dockerfile:1.7
# Vatra hub image (P4-01): Next.js standalone server, multi-arch (linux/arm64 for Pi 4/5, linux/amd64).
#   docker buildx build --platform linux/arm64,linux/amd64 -t ghcr.io/<owner>/vatra:<version> .
# State lives in ONE volume at /data: vmui.db, vatra-master.key (generated at first boot), credentials.env.
# Runs as the unprivileged `node` user; no secrets are baked into any layer.

ARG NODE_VERSION=24.11.1

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 / ssh2 / cpu-features compile when no prebuilt binary matches the platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm 12 is a native binary: corepack's shim looks for bin/pnpm.cjs and fails, so install the
# exact version from packageManager through npm (it pulls the matching @pnpm/exe.<platform>)
RUN npm install -g "$(node -p "require('./package.json').packageManager")" && pnpm --version
COPY apps/desktop/package.json apps/desktop/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter vmui... --config.minimumReleaseAge=0

FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 VATRA_STANDALONE=1
RUN pnpm exec next build && mkdir -p firmware-dist

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 PORT=3737 VMUI_HOST=0.0.0.0 \
    VMUI_DB_PATH=/data/vmui.db VMUI_CREDENTIALS_FILE=/data/credentials.env \
    VATRA_EMPTY_HOUSE=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/messages ./messages
# ESP32 firmware (P6-03): the release workflow drops firmware-dist into the context; empty otherwise
COPY --from=build --chown=node:node /app/firmware-dist ./firmware-dist
USER node
VOLUME ["/data"]
EXPOSE 3737
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3737/api/discover').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
