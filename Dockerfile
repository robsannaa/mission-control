# Authored locally after auditing this repo (no upstream Dockerfile exists).
# Standard multi-stage Next.js build; nothing here shells out to the host.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=optional --no-audit --no-fund

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Mission Control's own in-dashboard "Update" button (src/app/api/mission-control-update)
# does `git pull --ff-only` + `npm ci` + `npm run build` in place, so the runtime image
# needs git, the full source tree (not just build output), and .git/ itself — not just
# the .next/public/node_modules subset a normal production image would ship.
# sqlite3 (the CLI, not a Node module) is shelled out to by src/lib/usage-db.ts for
# usage tracking — also absent from the slim base image.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
# Mission Control shells out to the `openclaw` CLI at runtime (doctor/status/lint/etc),
# so the CLI runtime from the official gateway image is bundled in alongside it.
COPY --from=alpine/openclaw:latest /app /opt/openclaw-cli
RUN ln -sf /opt/openclaw-cli/openclaw.mjs /usr/local/bin/openclaw && \
    chown -R node:node /app /opt/openclaw-cli && \
    git config --system --add safe.directory /app
ENV OPENCLAW_BIN=/opt/openclaw-cli/openclaw.mjs
USER node
EXPOSE 3333
# Run next directly (not via npx, which spawns it as a child) so this process is
# PID 1: the update route can process.exit() after a successful rebuild and rely
# on the container's `restart: unless-stopped` policy to bring the new build up.
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3333"]
