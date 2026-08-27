FROM node:24-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3010
ENV STORAGE_DIR=/app/storage

WORKDIR /app

COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/prisma.config.ts ./prisma.config.ts
COPY docker-entrypoint.sh /usr/local/bin/radar-entrypoint

RUN mkdir -p /app/storage && chown node:node /app/storage && chmod +x /usr/local/bin/radar-entrypoint

USER node

EXPOSE 3010

ENTRYPOINT ["radar-entrypoint"]
