# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/jobs/package.json packages/jobs/
RUN npm ci --workspace=@lumina/shared --workspace=@lumina/jobs --include-workspace-root
COPY packages/shared packages/shared
COPY packages/jobs packages/jobs
RUN npm run build --workspace=@lumina/shared && npm run build --workspace=@lumina/jobs

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/jobs/package.json packages/jobs/
RUN npm ci --omit=dev --workspace=@lumina/shared --workspace=@lumina/jobs --include-workspace-root
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/jobs/dist packages/jobs/dist
WORKDIR /app/packages/jobs
CMD ["node", "dist/worker.js"]
