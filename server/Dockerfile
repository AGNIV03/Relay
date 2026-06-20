# ─── Build stage ───
FROM node:24-alpine AS build
WORKDIR /app
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm install
COPY server/ /app/server/
RUN npx prisma generate
RUN npm run build

# ─── Runtime stage ───
FROM node:24-alpine AS runtime
# ffmpeg powers on-the-fly transcoding
RUN apk add --no-cache ffmpeg
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/server/node_modules/@prisma ./node_modules/@prisma
EXPOSE 4000
# Apply migrations (or push schema) then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
