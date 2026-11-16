# syntax=docker/dockerfile:1.7
# One image, two processes (see docker-compose.yml): the Paddy server (owner console + pay page + agent API)
# and the Paddy bundler. No secrets are baked in: every key arrives as a runtime environment variable.

# ---- 1. build the web app
FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. production dependencies for the agent and the bundler
FROM node:24-alpine AS deps
WORKDIR /app
COPY agent/package.json agent/package-lock.json agent/
COPY bundler/package.json bundler/package-lock.json bundler/
RUN npm ci --omit=dev --no-audit --no-fund --prefix agent \
 && npm ci --omit=dev --no-audit --no-fund --prefix bundler

# ---- 3. runtime
FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=deps /app/agent/node_modules agent/node_modules
COPY --from=deps /app/bundler/node_modules bundler/node_modules
COPY agent/package.json agent/contacts.json agent/
COPY agent/abi agent/abi
COPY agent/src agent/src
COPY agent/scripts agent/scripts
COPY bundler/package.json bundler/
COPY bundler/src bundler/src
COPY docs/agent-live-run.json docs/live-demo.json docs/
COPY --from=web /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "--experimental-strip-types", "agent/src/server.ts"]
