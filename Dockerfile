# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
# Clerk's publishable key is inlined at build time (NEXT_PUBLIC_*); it is not a secret. Empty keeps self-host builds unchanged.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    AI_BILLS_CONFIG=/app/config.toml
# The Codex binary is Rust/rustls and reads the *system* trust store (Node ships
# its own roots, so only the CLI notices). Without this every codex login/refresh
# dies as "error sending request for url (https://auth.openai.com/...)".
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Codex CLI (device-auth flow) is spawned at runtime, outside Next's tracing.
# @openai/codex is only a JS launcher — the native binary ships in the platform
# package (@openai/codex-linux-x64), so the whole scope has to come along.
COPY --from=build /app/node_modules/@openai ./node_modules/@openai
EXPOSE 18088
CMD ["node", "server.js"]
