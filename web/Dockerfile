# ─── Build stage ───
FROM node:26-alpine AS build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
# Bake the public API URL into the client bundle at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

# ─── Runtime stage ───
FROM node:26-alpine AS runtime
WORKDIR /app/web
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone server binds to $HOSTNAME; Docker sets it to the container id
# (a single non-loopback interface), which makes the 127.0.0.1 healthcheck fail
# even though the app serves fine. Bind all interfaces instead.
ENV HOSTNAME=0.0.0.0
# Next.js "standalone" output bundles only what's needed.
# For a single (non-monorepo) project, server.js sits at the standalone root.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
EXPOSE 3000
# Run as the unprivileged node user (the standalone server is stateless).
USER node
CMD ["node", "server.js"]
