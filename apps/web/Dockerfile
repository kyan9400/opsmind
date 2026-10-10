# Built from the repo root (`docker build -f apps/web/Dockerfile .`), so npm ci installs exactly what
# package-lock.json pins: the dependency tree CI tests, not whatever the registry has that minute.
FROM node:22-alpine AS build
WORKDIR /app
# Every workspace's manifest, so npm sees the repo's workspace tree; -w installs only the web app's deps.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci -w apps/web --no-audit --no-fund
COPY apps/web apps/web
# All build-time: NEXT_PUBLIC_* are inlined into the client bundle and rewrites are frozen into the
# standalone server.
# NEXT_PUBLIC_API_URL: where the browser calls the API; "" means same origin (pair with API_INTERNAL_URL).
# API_INTERNAL_URL: when set, the Next.js server proxies /api/* to it (e.g. http://api:4000).
# NEXT_PUBLIC_DEMO_*: the public read-only demo login behind "Try the live demo"; empty hides the button.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG API_INTERNAL_URL=
ARG NEXT_PUBLIC_DEMO_EMAIL=
ARG NEXT_PUBLIC_DEMO_PASSWORD=
# NEXT_PUBLIC_SANDBOX: true shows "Try it with your own data"; pair it with ALLOW_SANDBOX=true on the API.
ARG NEXT_PUBLIC_SANDBOX=
# NEXT_PUBLIC_REGISTRATION: false hides every sign-up entry point; pair it with ALLOW_REGISTRATION=false on
# the API. Empty keeps sign-up on.
ARG NEXT_PUBLIC_REGISTRATION=
# NEXT_PUBLIC_SITE_URL: the public origin, e.g. https://opsmind.example.com, for the link-preview image,
# robots.txt and sitemap.xml (they need absolute URLs).
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_PUBLIC_DEMO_EMAIL=$NEXT_PUBLIC_DEMO_EMAIL \
    NEXT_PUBLIC_DEMO_PASSWORD=$NEXT_PUBLIC_DEMO_PASSWORD \
    NEXT_PUBLIC_SANDBOX=$NEXT_PUBLIC_SANDBOX \
    NEXT_PUBLIC_REGISTRATION=$NEXT_PUBLIC_REGISTRATION \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build -w apps/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Next traces files from the workspace root (where package-lock.json is), so the standalone output
# mirrors the repo: apps/web/server.js, with the node_modules it needs at the top.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node", "server.js"]
