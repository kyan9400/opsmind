FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# All build-time: NEXT_PUBLIC_* are inlined into the client bundle and rewrites are frozen into the
# standalone server.
# NEXT_PUBLIC_API_URL: where the browser calls the API; "" means same origin (pair with API_INTERNAL_URL).
# API_INTERNAL_URL: when set, the Next.js server proxies /api/* to it (e.g. http://api:4000).
# NEXT_PUBLIC_DEMO_*: the public read-only demo login behind "Try the live demo"; empty hides the button.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG API_INTERNAL_URL=
ARG NEXT_PUBLIC_DEMO_EMAIL=
ARG NEXT_PUBLIC_DEMO_PASSWORD=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_PUBLIC_DEMO_EMAIL=$NEXT_PUBLIC_DEMO_EMAIL \
    NEXT_PUBLIC_DEMO_PASSWORD=$NEXT_PUBLIC_DEMO_PASSWORD
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
