# eCommerce Node API

A plain Node.js implementation of the shop's backend: Express and ordinary libraries, no framework. It serves the **same HTTP
API** as the NestJS server in [`eCommerce-api`](../eCommerce-api) against the **same databases** (PostgreSQL, MongoDB,
Meilisearch, Redis, RabbitMQ), so a frontend can talk to any of the backends and they can even run side by side on one stack.

| | Nest (`eCommerce-api`) | Go (`eCommerce-go`) | Node (this repository) | .NET (`eCommerce-dotnet`) |
|---|---|---|---|---|
| Port in the compose files | 3333 | 3334 | 3335 | 3336 |
| Owns the PostgreSQL schema | **yes** (Prisma migrations) | no | no | no |

## How it is kept identical

1. **The Nest test suite runs against this server.** `eCommerce-api` has a test harness mode: with `API_BIN` and `API_ARGS`
   pointing at the server built here, its 65 integration specs start it as a child process and run unchanged over HTTP (auth,
   accounts, catalog, admin catalog, cart, checkout, orders, payments, messaging, metrics, contract shapes). The one spec that
   calls a Nest internals directly (the abandoned-cart job) is covered by `src/messaging/scheduler.spec.ts` here.
2. **The business rules are the shared package.** Pricing, coupons, serviceability, order transitions and permissions come from
   `@ecom/contracts`, the very code the frontend and the Nest API use, so there is nothing to keep in sync.
3. **Passwords and tokens interoperate.** Argon2id hashes (same parameters), JWT access tokens (same secret, claims, audience,
   issuer) and the refresh-token table are shared, so a user created on one server can sign in on another and a token from one
   is accepted by the others.
4. **A differential probe** records how both servers answer odd requests (malformed JSON, unknown routes, CORS preflight,
   conditional GETs, missing CSRF headers ...) and the answers were diffed.

## Run it

```bash
# 1. The data stores and the schema come from the Nest stack (eCommerce-api):
cd ../eCommerce-api && docker compose up -d postgres redis mongo rabbitmq meilisearch api-migrate catalog-seed
# 2. The Node API in Docker:
cd ../eCommerce-node && docker compose up --build -d      # http://localhost:3335
```

Or without Docker, with the same environment variables as the Nest API (`DATABASE_URL`, `MONGODB_URL`, `MEILI_URL`, `REDIS_URL`,
`RABBITMQ_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGINS`, optional Razorpay test keys, `PORT`):

```bash
pnpm install          # also downloads @ecom/contracts from its tagged GitHub release
pnpm db:generate      # typed database client, from prisma/schema.prisma
pnpm dev              # tsx watch, or: pnpm build && pnpm start
```

## Test it

```bash
pnpm verify           # typecheck, unit tests (24), build

# the shared integration specs, against this server
pnpm build
cd ../eCommerce-api/apps/api
API_BIN=node API_ARGS="<path to this repo>/dist/main.js" pnpm exec vitest run test/
```

The unit tests cover the body validator, configuration, circuit breaker, retry, Razorpay signatures and the abandoned-cart job
(the last one needs the test PostgreSQL that the Nest specs also use and skips itself when it is not reachable).

## Layout

`src/main.ts` entry · `src/app.ts` the Express pipeline (the Nest `configureApp`) · `src/container.ts` hand-written wiring (the
Nest module) · `src/routes/*` the routes (the Nest controllers) · `src/http/*` errors, request ids, guards, cookies, body
validation, rate limiting, route registration · `src/{auth,accounts,addresses,catalog,commerce,cache,messaging,metrics,resilience}`
the services · `prisma/schema.prisma` a verbatim copy of the Nest schema, used only to generate the typed client.

## Differences from the Nest server

- There is no OpenAPI/Swagger page (`/docs`); the routes are the same.
- The schema is not migrated from here. Run the Nest API's migrations (`pnpm db:migrate:deploy`, or its `api-migrate` compose
  service) first, and copy `prisma/schema.prisma` over when it changes.
- Log lines are JSON objects with `time`, `level`, `logger` and `message`, not Nest's text format.
- A request whose path has a broken percent-encoding gets the same 400 as in Nest, but with a `requestId` in the body (Nest's
  answer omits it).
