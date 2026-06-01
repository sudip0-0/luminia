# Lumina

Lumina is a mobile-first, anti-doomscroll knowledge feed. This repository is a
TypeScript monorepo managed with npm workspaces, organized into three tiers
described in the design document.

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

## Per-workspace

```bash
npm test --workspace @lumina/api
npm run build --workspace @lumina/shared
npm start --workspace @lumina/mobile   # expo start
```
