# ─── Build stage ───
FROM node:26-alpine AS build
WORKDIR /app
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm install
COPY server/ /app/server/
# `npm run build` runs `prisma generate` first. Generate doesn't connect to the
# DB, but prisma.config.ts evaluates env("DATABASE_URL"), so give it a dummy URL
# for the build (the real one is injected by docker-compose at runtime).
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

# ─── Runtime stage ───
FROM node:26-alpine AS runtime
# ffmpeg powers on-the-fly transcoding; su-exec drops root after fixing volume perms
RUN apk add --no-cache ffmpeg su-exec
# chromaprint provides `fpcalc` for the opt-in AcoustID auto-tagging
# (ACOUSTID_API_KEY). Optional: if the package is unavailable the build still
# succeeds and the server just logs that auto-tagging is disabled.
RUN apk add --no-cache chromaprint || echo "chromaprint unavailable — fpcalc (auto-tagging) disabled"
WORKDIR /app/server
ENV NODE_ENV=production
# Prisma 7 is a prod dependency now (the runtime needs the CLI for `migrate
# deploy`), so --omit=dev still installs prisma + @prisma/client + @prisma/adapter-pg.
COPY server/package*.json ./
RUN npm install --omit=dev
# The Prisma 7 client is Rust-free and compiled into dist (no node_modules/.prisma
# engine to copy). Bring the compiled app, the schema/migrations, and the Prisma
# config (needed by `migrate deploy`).
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/prisma.config.ts ./prisma.config.ts
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 4000
# The entrypoint fixes volume ownership as root, then runs the app as `node`.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
