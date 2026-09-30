# Multi-stage build: compile TypeScript, ship only runtime deps.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Every node process in this image (api, worker, migrations) preloads tracing; it is a no-op
# unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Set only after dist/ exists: npm is a node process too.
ENV NODE_OPTIONS="--import ./dist/tracing.js"
USER node
# 4000: API, 9100: worker metrics
EXPOSE 4000 9100
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["sh", "-c", "node dist/lib/migrate.js && node dist/server.js"]
