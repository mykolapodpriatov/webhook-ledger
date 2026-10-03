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

The store is in memory, in one process. Two requests cannot interleave inside `accept` because that path does not await. A second instance would need a unique constraint on `(tenant_id, idempotency_key)`. `MemoryLedgerStore` is the seam for that.

## Run

Node 22 or newer, pnpm 10.

```bash
pnpm install
cp .env.example .env
# edit LEDGER_TENANTS, then:
set -a && source .env && set +a
pnpm build
pnpm start
```

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

Vitest runs the signature checks, the ledger rules, and Fastify `inject` tests against the same raw-body setting production uses. CI runs those plus the TypeScript build.

## Layout

```
src/ledger/signature.ts          HMAC over the raw bytes
src/ledger/ledger.service.ts     accept, replay, conflict, read
src/ledger/memory-ledger.store.ts
src/ledger/ledger.controller.ts  Fastify routes
src/main.ts                      rawBody: true, listen
```
