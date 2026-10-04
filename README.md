# webhook-ledger

[![CI](https://github.com/mykolapodpriatov/webhook-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/mykolapodpriatov/webhook-ledger/actions/workflows/ci.yml)

NestJS 11 on Fastify. Senders POST a signed webhook. The service stores that delivery once for the tenant, and the tenant reads the events back in order.

The signature covers the raw request bytes. Parsing the JSON and signing the result is a different payload, and this service rejects it.

## Guarantees

These are what the tests lock in:

- HMAC-SHA256 over `timestamp`, a dot, and the raw body. The comparison uses `timingSafeEqual`.
- A timestamp more than 300 seconds off the server clock is rejected, and only after the signature matches. The error is `stale_timestamp`. A wrong signature is `invalid_signature`, including for an unknown tenant. The process HMAC key for unknown tenants is random, so a caller cannot forge the "unknown" case and tell it apart.
- `Idempotency-Key` is scoped to the tenant. The same key and the same bytes return the original event (`200`, `replayed`) and do not advance the sequence. The same key with different bytes is `409` and stores nothing.
- The read API takes a separate bearer token. A wrong token and an unknown tenant both come back as `unauthorized`. One tenant's feed never includes another tenant's events.
- The feed cursor is exclusive. `nextCursor` is the sequence to pass back as `after`.

Deliveries are rows in Postgres. `accept` writes the idempotency key and the next sequence in one transaction. A unique index on `(tenant_id, idempotency_key)` stops two concurrent requests with the same key from both inserting: the loser rolls back, including its sequence increment, then reads the row the winner stored. Sequences stay contiguous and start at 1 for each tenant. `MemoryLedgerStore` implements the same rules in process memory. The unit tests use it. The process uses Postgres when `DATABASE_URL` is set.

## Run

Node 22 or newer, pnpm 10.

```bash
docker compose up -d
pnpm install
cp .env.example .env
# edit LEDGER_TENANTS, then:
set -a && source .env && set +a
pnpm build
pnpm start
```

Compose publishes Postgres on host port 54329 (user `ledger`, database `webhook_ledger`) so it does not take a local 5432. The process applies `drizzle/*.sql` on startup. There is no drizzle-kit step. `DATABASE_URL` is required. The process exits if it is missing.

Docs are at `http://localhost:3000/docs`. Health is `GET /health`.

Sign a body the same way the server does (`examples/sign.mjs` matches `src/ledger/signature.ts`):

```bash
secret=replace-with-a-long-secret
body='{"type":"invoice.paid","id":"inv_1"}'
ts=$(date +%s)
sig=$(node examples/sign.mjs "$secret" "$ts" "$body")

curl -sS -D- http://localhost:3000/v1/tenants/acme/events \
  -H 'content-type: application/json' \
  -H 'idempotency-key: inv_1' \
  -H "x-webhook-timestamp: $ts" \
  -H "x-webhook-signature: $sig" \
  -d "$body"
```

A new delivery is `202`. The same request again is `200` with `"status": "replayed"` and the same `id`.

Read it back:

```bash
curl -sS http://localhost:3000/v1/tenants/acme/events \
  -H 'authorization: Bearer replace-with-a-long-token'
```

`LEDGER_TENANTS` is a JSON array of `{ id, ingestSecret, readToken }`. Both secrets must be at least 16 characters. The process exits on startup if the variable is missing, is not JSON, or repeats an id.

## HTTP

| Request                                          | Result                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `POST /v1/tenants/:tenantId/events`              | `202` accepted, `200` replayed, `401` bad or stale signature, `409` same key and different body                |
| `GET /v1/tenants/:tenantId/events?after=&limit=` | events with `sequence` greater than `after`. A missing or malformed bearer header is 400. A wrong token is 401 |
| `GET /health`                                    | `{ "status": "ok" }`                                                                                           |
| `GET /docs`                                      | Swagger UI, generated from the Zod DTOs                                                                        |

Headers on POST: `idempotency-key`, `x-webhook-timestamp` (unix seconds), `x-webhook-signature` (hex HMAC). The body is a JSON object, up to 256 KiB. The idempotency key is 1 to 128 characters from `[A-Za-z0-9._:-]`.

`limit` defaults to 50 and cannot be higher than 200.

Validation is Zod through `nestjs-zod`. OpenAPI is `@nestjs/swagger`, then `cleanupOpenApiDoc`, which is what makes the Zod schemas show up in the document.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Vitest runs the signature checks, the ledger rules, and Fastify `inject` tests against the same raw-body setting production uses. Those stay on the memory store.

Set `DATABASE_URL` (compose above is enough) and the Postgres suite runs too: replay, conflict, per-tenant sequences, and concurrent inserts against a real database. CI sets that variable on the test job. The quality job does not need a database. If `CI` is set and `DATABASE_URL` is missing, the Postgres file fails instead of skipping.

## Layout

```
src/ledger/signature.ts             HMAC over the raw bytes
src/ledger/ledger.service.ts        accept, replay, conflict, read
src/ledger/ledger-store.ts          save and listAfter
src/ledger/memory-ledger.store.ts   unit-test double
src/ledger/postgres-ledger.store.ts Drizzle, migrates on boot
src/db/schema.ts                    tables
drizzle/0000_init.sql               committed SQL
src/ledger/ledger.controller.ts     Fastify routes
src/main.ts                         rawBody: true, DATABASE_URL, listen
docker-compose.yml                  Postgres 16 on port 54329
```
