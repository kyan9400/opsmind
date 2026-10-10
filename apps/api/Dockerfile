# Multi-stage build: compile TypeScript, ship only runtime deps.
# Built from the repo root (`docker build -f apps/api/Dockerfile .`), so npm ci installs exactly what
# package-lock.json pins: the dependency tree CI tests, not whatever the registry has that minute.
FROM node:22-alpine AS build
WORKDIR /app
# Every workspace's manifest, so npm sees the repo's workspace tree; -w installs only the API's deps.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci -w apps/api --no-audit --no-fund
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/scripts apps/api/scripts
RUN npm run build -w apps/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev -w apps/api --no-audit --no-fund && npm cache clean --force
# Dependencies sit in /app/node_modules. Running from the workspace directory keeps the relative paths
# that compose, Helm and CI use (`node dist/...`).
WORKDIR /app/apps/api
COPY --from=build /app/apps/api/dist ./dist
COPY apps/api/migrations ./migrations
# Every node process in this image (api, worker, migrations) preloads tracing; it is a no-op
# unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Set only after dist/ exists: npm is a node process too.
ENV NODE_OPTIONS="--import ./dist/tracing.js"
USER node
# 4000: API, 9100: worker metrics
EXPOSE 4000 9100
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["sh", "-c", "node dist/lib/migrate.js && node dist/server.js"]
