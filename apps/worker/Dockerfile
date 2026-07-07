# Build from repo root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/storage packages/storage
COPY apps/worker apps/worker
RUN pnpm --filter @docqa/shared build && pnpm --filter @docqa/storage build && pnpm --filter @docqa/worker build
RUN pnpm --filter @docqa/worker --prod deploy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
COPY --from=build /app/apps/worker/dist ./dist
USER node
CMD ["node", "dist/index.js"]
