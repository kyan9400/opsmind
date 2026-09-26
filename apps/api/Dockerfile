# Multi-stage build: compile TypeScript, ship only runtime deps.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Every node process in this image (api, worker, migrations) preloads tracing; it is a no-op
# unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
ENV NODE_OPTIONS="--import ./dist/tracing.js"
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
# 4000: API, 9100: worker metrics
EXPOSE 4000 9100
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["sh", "-c", "node dist/lib/migrate.js && node dist/server.js"]
