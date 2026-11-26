# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM build AS quality
RUN pnpm run check

FROM quality AS verified-build

FROM node:24-bookworm-slim AS production-dependencies

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    HUSH_NODE_DATA_DIR=/data

ENV ALLOW_PLAINTEXT_REMOTE=true

WORKDIR /app
RUN groupadd --gid 10001 hushnode \
    && useradd --uid 10001 --gid hushnode --no-create-home --system hushnode \
    && mkdir --parents /data \
    && chmod 0700 /data \
    && chown --recursive hushnode:hushnode /data

COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=verified-build --chown=10001:10001 /app/dist ./dist
COPY --from=verified-build --chown=10001:10001 /app/package.json ./package.json

USER 10001:10001
EXPOSE 8788
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8788') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--no-warnings", "dist/server.js"]
