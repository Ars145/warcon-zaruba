# Warcon: Bun + SvelteKit; the database is Postgres/TimescaleDB (see docker-compose.yml).
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 CHROMIUM_PATH=/usr/bin/chromium
# The worker photographs the match result card in Chromium. The image carries no fonts of its
# own, and 6% of the names seen in a week are CJK, dingbats or emoji, so the Noto families are
# not optional: without them those names render as empty boxes.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && rm -rf ~/.bun/install/cache
COPY --from=build /app/build ./build
COPY drizzle ./drizzle
COPY docker-entrypoint.sh ./
USER bun
EXPOSE 3000 7700
# The web (and single-process) roles answer on 3000; the worker on WORKER_PORT (7700). Probing every
# 2 s while starting lets a rolling deploy switch to a new container seconds after it is ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s CMD bun -e "const w = (process.env.WARCON_ROLE || 'all') === 'worker'; fetch(w ? 'http://127.0.0.1:' + (process.env.WORKER_PORT || 7700) + '/health' : 'http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# The commit shown on the Admin overview is read from .git during the build (build/commit). This
# argument is only for a context that arrives without .git; last, so it re-uses every layer above.
ARG WARCON_COMMIT=""
ENV WARCON_COMMIT=$WARCON_COMMIT
CMD ["./docker-entrypoint.sh"]
