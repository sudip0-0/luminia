# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --workspace=@lumina/shared --workspace=@lumina/api --include-workspace-root
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npm run build --workspace=@lumina/shared && npm run build --workspace=@lumina/api

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev --workspace=@lumina/shared --workspace=@lumina/api --include-workspace-root
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY packages/api/migrations packages/api/migrations
WORKDIR /app/packages/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
