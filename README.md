# DB Viewer

A fast, multi-database viewer/editor in the spirit of VSCode's `database-client`
— built as a standalone web app (Node.js/Fastify backend, React/Vite/Tailwind
frontend) instead of an editor extension, so the data grid can be properly
virtualized for very large tables.

## Status

This is a working Phase 1 implementation, verified end-to-end (including
against real local Postgres and MySQL instances, not just SQLite):

- ✅ Driver registry + `DatabaseDriver` contract (`packages/driver-interface`)
- ✅ SQLite driver (`packages/drivers/sqlite`) — zero-setup
- ✅ MongoDB driver (`packages/drivers/mongodb`) — zero-setup
- ✅ PostgreSQL driver (`packages/drivers/postgres`) — cursor streaming, cancellable exact counts via `pg_cancel_backend`
- ✅ MySQL driver (`packages/drivers/mysql`) — streaming via the underlying callback connection, cancellable exact counts via `KILL QUERY`
- ✅ Fastify server: connection management (encrypted-at-rest, persisted to disk across restarts), keyset-paginated row browsing, WebSocket query streaming, inline cell editing
- ✅ React frontend: multi-connection picker/switcher (with localStorage-remembered active connection so a page refresh doesn't lose your place), schema sidebar, virtualized data grid (TanStack Table + Virtual), SQL editor with live streaming results
- ⏳ Redis / ClickHouse drivers — not yet started, follow the pattern in `packages/drivers/postgres`
- ⏳ Monaco editor, ER diagrams, saved queries, — Phase 2+ per the roadmap below

## Quick start

```bash
pnpm install
pnpm approve-builds better-sqlite3 esbuild   # one-time, compiles the native sqlite binding

# terminal 1
pnpm dev:server   # Fastify on :4000

# terminal 2
pnpm dev:web      # Vite on :5173, proxies /api and /ws to :4000
```

Open http://localhost:5173, connect to a SQLite file (or a Postgres database),
and browse.

## How it scales to very large tables

- **No `OFFSET`.** Every browse request uses keyset pagination on the primary
  key (`WHERE (pk1, pk2, ...) > (v1, v2, ...) ORDER BY pk LIMIT n`), so page 10
  costs the same as page 10,000.
- **No `SELECT COUNT(*)` by default.** The grid header shows a fast estimate
  from the database's own statistics (`pg_class.reltuples`, `MAX(rowid)` for
  SQLite); an exact count is available as an explicit, separate, cancellable
  request.
- **Streaming, not buffering.** The SQL editor runs queries over a WebSocket
  and streams rows back in chunks as the database cursor produces them — the
  server never materializes a full result set in memory, and the client
  starts rendering rows before the query finishes.
- **Virtualized rendering.** The data grid (TanStack Virtual) only ever
  mounts the rows currently in the viewport, so the DOM node count is
  constant whether the table has 200 rows or 200 billion.
- **Cancellable everything.** Long browse requests and exact counts are tied
  to an `AbortController`; closing the connection or clicking cancel actually
  kills the underlying database query, not just the HTTP request.

## Adding a new database driver

1. `packages/drivers/<name>/` — new package implementing `DatabaseDriver` from
   `@db-viewer/driver-interface`.
2. Register it in `apps/server/src/registry.ts` — one line.

Nothing else changes. The server, the connection store, and every frontend
component only ever talk to the shared interface.

## Roadmap

- **Phase 2** — inline cell editing polish (optimistic UI + rollback), Monaco
  SQL editor with autocomplete, saved queries.
- **Phase 3** — Redis, ClickHouse drivers; a JSON-tree grid mode for
  NoSQL documents.
- **Phase 4** — ER diagram generation from introspected foreign keys,
  `EXPLAIN ANALYZE` visualizer, result-set diffing.
- **Phase 5** — command palette, themes, team connection sharing, published
  plugin SDK docs for third-party drivers.

## Persistence & security

Connection configs (including passwords) persist to
`apps/server/.data/connections.json` so they survive server restarts.
Passwords are encrypted at rest with AES-256-GCM using a key that's
auto-generated on first run and stored alongside the data
(`apps/server/.data/secret.key`). This is demo-grade key management — the
key lives on the same disk as the ciphertext, which is fine for a local dev
tool but not a shared server. Before any real multi-user deployment, source
the key from an OS keychain or secrets manager instead, and add auth in
front of the API.

On the frontend, only the *last active connection id* is kept in
`localStorage` (not credentials) — the connection list and everything else
comes fresh from the server on every load.
