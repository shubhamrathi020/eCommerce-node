# eCommerce Node API: Claude Instructions

The plain Node.js (Express) implementation of the shop API. It must answer exactly like `eCommerce-api` (NestJS), which owns the
PostgreSQL schema and the integration specs. Solo project; the user pushes (never run `git push`).

## Sibling repositories
- `eCommerce`: Angular apps, requirements (`brds/`), project log, steering docs. Read `steering/rules.md` there before a big task.
- `eCommerce-api`: NestJS backend, the source of truth for behaviour, schema and specs.
- `eCommerce-go`, `eCommerce-dotnet`: the other implementations of the same API.
- `eCommerce-contracts`: `@ecom/contracts`, shared types and pure rules. A shape or rule both sides use is changed there first.
- `eCommerce-react`: React apps that can talk to any backend.

## Rules of this repository
- Behaviour parity beats cleverness. When Nest does something odd (statuses, messages, cookie paths, header names), copy it.
- Never recompute a rule that `@ecom/contracts` already has.
- `prisma/schema.prisma` and `docs/*` (the OpenAPI document and Swagger UI page) are copies; change them in `eCommerce-api` first (`test/export-openapi.spec.ts` regenerates `docs/`). This repository never migrates.
- A new route needs the same guard order as Nest: blanket rate limit, bucket limit, authentication, CSRF, body validation, handler.
- Commit after each finished unit. Never push. Files containing apostrophes in shell heredocs break the tool; use the editor tools.

## Commands
- `pnpm verify` runs typecheck, unit tests and the build. `pnpm db:generate` must have run once.
- The shared specs: `API_BIN=node API_ARGS="<repo>/dist/main.js" pnpm exec vitest run test/` from `eCommerce-api/apps/api`
  (needs the Docker infrastructure from `eCommerce-api` running). Specs run one file at a time against one database.

## Lessons
- Express 4 does not catch async errors: every handler goes through `Routes` (`src/http/route.ts`), which forwards rejections.
- Nest turns only `SyntaxError` and `URIError` from the framework into 400s; any other framework error (an oversized body) is a 500.
- Nest sends 201 for POST unless told otherwise; many cart/order routes rely on that.
