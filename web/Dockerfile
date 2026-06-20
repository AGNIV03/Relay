# ─── Build stage ───
FROM node:24-alpine AS build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
# Bake the public API URL into the client bundle at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

# ─── Runtime stage ───
FROM node:24-alpine AS runtime
WORKDIR /app/web
ENV NODE_ENV=production
ENV PORT=3000
# Next.js "standalone" output bundles only what's needed.
# For a single (non-monorepo) project, server.js sits at the standalone root.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
