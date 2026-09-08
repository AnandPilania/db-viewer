# server

The [db-viewer](../../README.md) backend: a Fastify app that talks to every
database driver through `@pilaniaanand/driver-interface` and serves both the
API and (in production) the built frontend from one port.

## Running

```bash
pnpm dev          # tsx watch src/index.ts, :4000
pnpm build        # tsc -p tsconfig.json -> dist/
pnpm start        # node dist/index.js
pnpm typecheck
```

`PORT` (default `4000`), `LOG_LEVEL` (default `info`), `NODE_ENV`, and
`DB_VIEWER_READ_ONLY=true` (forces every connection read-only regardless of
its own config) are the environment variables that matter at runtime.
`DB_VIEWER_HOME` overrides where installed drivers are looked for (see
`driver-home.ts`).

## Layout

- **`index.ts`** — bootstrap: builds the shared logger, registers process-
  level crash handlers, registers plugins then routes, starts listening.
- **`registry.ts`** / **`driver-home.ts`** — driver discovery. Each driver is
  an optional dependency, resolved at startup via normal Node module
  resolution first (the monorepo/local-dev path), then a fixed
  `~/.db-viewer/drivers` home (the `npx db-viewer` / global-install path).
- **`connection-store.ts`** — persists connection configs to
  `.data/connections.json`. Every secret (password, TLS client key, SSH
  private key/passphrase/password) is AES-256-GCM encrypted at rest via
  `crypto.ts` and redacted in every API response.
- **`ssh-tunnel.ts`** — opens a local forwarded port through an SSH bastion
  before a driver ever sees a `ConnectionConfig`, so no individual driver
  needs to be tunnel-aware.
- **`read-only.ts`** — enforces `ConnectionConfig.readOnly` /
  `DB_VIEWER_READ_ONLY` before any write route or `execute()`/`streamQuery`
  call reaches a driver. Fails closed: `isDestructiveExec` only recognizes a
  fixed allowlist of read-shaped queries per language.
- **`table-events.ts`** — in-process pub/sub bus keyed by
  `(connectionId, table)`. Every write route publishes here after success;
  `ensureNativeWatch`/`releaseNativeWatch` refcount each driver's
  `watchTable` so only one native/poll watcher is ever open per table no
  matter how many browser tabs are watching it.
- **`chart-query.ts`** — builds validated queries for dashboard widgets.
  Every table/column a widget references is checked against the connection's
  real schema at creation time — the only defense a public embed view needs,
  since it can never pass through arbitrary SQL/pipeline/table names, only
  replay a widget's pre-saved query.
- **`logger.ts`** — one shared `pino` instance for the whole process; every
  module logs through it instead of `console.error`, writing to a daily-
  rotating file under `logs/` (via `pino-roll`) plus the console (pretty in
  dev, structured JSON in prod).
- **`routes/`** — one file per resource: `connections.ts` (CRUD + browse/
  edit/delete rows + `execute`), `stream.ts` (WebSocket query streaming for
  the SQL editor), `export.ts` (streaming CSV/NDJSON), `widgets.ts` /
  `dashboards.ts` (dashboard builder), `watch.ts` / `public-watch.ts`
  (authenticated vs. token-gated public realtime), `client-errors.ts`
  (frontend error reports land in the same daily log file as server errors).
- **`plugins/`** — `error-handler.ts` (the safety net: sanitized 5xx
  responses, no leaked stack traces), `rate-limit.ts`, `cors.ts`,
  `websocket.ts`, `graceful-shutdown.ts` (closes every open DB connection and
  SSH tunnel on SIGINT/SIGTERM), `static-frontend.ts` (SPA fallback once a
  built frontend exists).

## Security model

- **SQL injection**: every SQL-family driver validates identifiers
  (table/schema/column names, filter operators) against a fixed charset
  before interpolating them into a query string — see
  `@pilaniaanand/driver-interface`'s `assertSafeIdentifier`. Values always go
  through the driver's real parameter binding (ClickHouse excepted, which has
  none — see its own README).
- **Read-only mode**: three independent levers — `DB_VIEWER_READ_ONLY=true`
  (global), a connection's own `readOnly: true`, or (the one this app can't
  bypass no matter what bug exists here) connecting with a database role
  that only has `SELECT` granted.
- **Secrets at rest**: AES-256-GCM, demo-grade key management (the key lives
  on the same disk as the ciphertext under `.data/secret.key`) — fine for a
  local tool, not for a shared server. Source the key from an OS keychain or
  secrets manager before any multi-user deployment, and add auth in front of
  the API (there is none today).
