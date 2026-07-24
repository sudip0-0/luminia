# Lumina

Lumina is a mobile-first, anti-doomscroll knowledge feed. This repository is a
TypeScript monorepo managed with npm workspaces, organized into three tiers
described in [`.kiro/specs/lumina/design.md`](.kiro/specs/lumina/design.md).

## Workspaces

| Workspace | Package | Tier | Stack |
|---|---|---|---|
| `packages/shared` | `@lumina/shared` | Shared | TypeScript domain types and utilities |
| `packages/api` | `@lumina/api` | Backend API | Fastify (TypeScript) |
| `packages/jobs` | `@lumina/jobs` | Ingestion & Jobs | BullMQ repeatable jobs |
| `apps/mobile` | `@lumina/mobile` | Mobile_App | React Native + Expo |

## Toolchain

- **Language:** TypeScript with project references (`tsconfig.base.json` + per-workspace `tsconfig.json`).
- **Test runner:** Vitest in single-run mode (`npm test` → `vitest run`).
- **Property-based testing:** `fast-check` (minimum 100 generated iterations per property).
- **Linting:** ESLint (flat config) with `typescript-eslint`.

## Common commands

```bash
npm install        # install all workspace dependencies
npm test           # run all tests once (vitest run)
npm run typecheck  # type-check all workspaces (tsc --build)
npm run build      # build all workspaces
npm run lint       # lint the repository
```

## Local infrastructure

Copy [`.env.example`](.env.example) to `.env` and start dependencies:

```bash
docker compose up -d postgres redis typesense
npm run build --workspace @lumina/shared
npm run build --workspace @lumina/api
npm run migrate --workspace @lumina/api
npm run start --workspace @lumina/api
npm run start --workspace @lumina/jobs   # BullMQ worker (needs REDIS_URL)
```

Full stack (API + jobs + deps):

```bash
docker compose up --build
```

### Required environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis for denylist, lockout, feed paging, jobs |
| `AUTH_ACCESS_TOKEN_SECRET` | JWT signing secret (≥32 chars; required outside test) |
| `TYPESENSE_HOST` / `TYPESENSE_API_KEY` | Search (optional; search routes mount when set) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional OTLP HTTP traces |

Health: `GET /health` (liveness). Readiness: `GET /ready` (Postgres + Redis + Typesense when configured).

## Per-workspace

```bash
npm test --workspace @lumina/api
npm run build --workspace @lumina/shared
npm start --workspace @lumina/mobile   # expo start
```

## Auth notes

Public routes: `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/oauth/:provider`,
authenticated `POST /auth/logout`. OAuth uses a pluggable verifier injected at bootstrap
(no live Google/Apple console required for local/tests).
