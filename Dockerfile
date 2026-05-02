# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: build (TypeScript -> dist/)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY persona ./persona
COPY public ./public
COPY openapi.yaml ./openapi.yaml

RUN npm run build
RUN npm prune --omit=dev


# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn

RUN apk add --no-cache tini && \
    addgroup -S aelora && adduser -S aelora -G aelora

WORKDIR /app

COPY --from=builder --chown=aelora:aelora /app/node_modules ./node_modules
COPY --from=builder --chown=aelora:aelora /app/dist          ./dist
COPY --from=builder --chown=aelora:aelora /app/persona       ./persona
COPY --from=builder --chown=aelora:aelora /app/public        ./public
COPY --from=builder --chown=aelora:aelora /app/openapi.yaml  ./openapi.yaml
COPY --from=builder --chown=aelora:aelora /app/package.json  ./package.json

COPY --chown=aelora:aelora settings.cloudrun.yaml ./settings.yaml

RUN mkdir -p /tmp/aelora-data && chown -R aelora:aelora /tmp/aelora-data
ENV AELORA_DATA_DIR=/tmp/aelora-data

ENV PORT=3000

EXPOSE 3000
USER aelora

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "AELORA_WEB_PORT=${PORT:-3000} exec node dist/boot.js"]
