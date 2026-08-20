# DB Viewer

A fast, multi-database viewer/editor in the spirit of VSCode's `database-client`
— built as a standalone web app (Node.js/Fastify backend, React/Vite/Tailwind
frontend) instead of an editor extension, so the data grid can be properly
virtualized for very large tables.

## Status

This is a working implementation, verified end-to-end against real local
Postgres, MySQL, Redis, and SQLite instances (MongoDB is typechecked but
couldn't be live-tested — no MongoDB server available in the sandbox this
was built in):

- ✅ Driver registry + `DatabaseDriver` contract (`packages/driver-interface`)
- ✅ SQLite, PostgreSQL, MySQL drivers — cursor/keyset pagination, cancellable exact counts
- ✅ MongoDB driver (`packages/drivers/mongodb`) — collections-as-tables, `_id`-based keyset pagination, JSON query/command syntax since Mongo has no SQL
- ✅ Redis driver (`packages/drivers/redis`) — adapts key/type storage to the tabular contract: each of the 6 key types (string/hash/list/set/zset/stream) is a pseudo-table, one row per key with a bounded value preview, Redis's own `SCAN` cursor reused directly as our pagination cursor
- ✅ ClickHouse driver (`packages/drivers/clickhouse`) — talks to ClickHouse's HTTP interface directly (no client library dependency), verified against a real local server including a UInt64-cursor quoting fix (ClickHouse serializes 64-bit ints as JSON strings) and its async mutation-based UPDATE/DELETE (`ALTER TABLE ... UPDATE/DELETE`)
- ✅ Full CRUD, verified end-to-end for every driver except Mongo: Create (insert), Read (paginated browse), Update (inline cell edit), Delete (row delete) — each confirmed via create→read→update→read→delete→read-confirms-gone against real databases
- ✅ Realtime, including real CDC for two drivers: every insert/update/delete made through the app broadcasts over WebSocket to every other client watching that table. **Postgres** auto-installs a trigger + `pg_notify` on first watch and `LISTEN`s on a shared channel — verified by writing directly via raw `psql`, bypassing the app entirely. **Redis** enables keyspace notifications and subscribes via pub/sub — verified the same way with raw `redis-cli` writes (one honest limitation: a brand-new key surfaces as an ignorable "update" rather than an "insert", since keyspace notifications don't distinguish new-vs-existing keys). **MongoDB** uses native Change Streams. MySQL and ClickHouse have no equivalent low-effort mechanism — app-originated events only for those two.
- ✅ Dashboards (Metabase/Salesforce-report style): saved chart widgets — create, edit, and delete/remove-from-dashboard, all through the builder UI — arranged with drag-and-resize grid layout (react-grid-layout, debounce-persisted). Chart data works for **all 6 implemented drivers**: Postgres/MySQL/SQLite/ClickHouse via validated SQL (ClickHouse's HTTP interface doesn't bind params the way the others do, so its values are literal-embedded with the same escaping the driver itself uses — verified against a SQL-injection attempt), MongoDB via a validated aggregation pipeline, and Redis with `number`/`table` only (no groupable field across keys, so bar/line/pie are explicitly rejected rather than faked). Widgets in the authenticated builder refetch instantly on any change to their underlying table (reusing the same realtime channel table browsing uses) rather than waiting out the 30s poll. The public embed view gets its own realtime too, through a separate token-gated WebSocket that only ever sends a content-free "changed" ping — never raw row data or which connection/table a widget reads from — so an embedded page can't use it to see more than the dashboard creator intended
- ✅ Fastify server: connection management (encrypted-at-rest, persisted to disk across restarts), keyset-paginated row browsing, WebSocket query streaming, streaming CSV/NDJSON export, a real plugin system (CORS, rate limiting, centralized error handling, graceful shutdown that actually closes every open DB connection)
- ✅ React frontend: multi-connection picker/switcher (localStorage-remembered active connection), schema sidebar, virtualized data grid, Monaco SQL editor with schema-aware autocomplete, ER diagrams (React Flow + dagre auto-layout), dashboard builder — all lazy-loaded so the initial bundle stays small
- ⏳ MySQL and ClickHouse CDC (would need binlog replication / no equivalent mechanism)

### Known-fixed bugs

**Postgres identifier folding.** Table names with mixed case or special
characters (e.g. Salesforce-style `AI_Prompt_Guide_Mapping__c`) used to fail
with `relation "..." does not exist`. Root cause: primary-key lookups cast
`schema || '.' || table` directly to `::regclass`, which triggers Postgres's
default identifier folding (lowercasing) on unquoted strings. Fixed by
routing through `quote_ident()`. Also fixed: unanalyzed Postgres tables
showing `-1` as their row-count estimate instead of a sensible value.

**Cancellation signal firing prematurely (affects every driver).**
`req.raw.on("close", ...)`, used everywhere to wire request cancellation
into an `AbortController`, fires as soon as Fastify finishes parsing the
request body — not when the client actually disconnects. This was found via
the Redis driver (the only one that explicitly checks `signal.aborted`
before starting work, so it was the only one that surfaced the bug as
silent empty results), but the same premature-firing behavior likely made
cancellation unreliable for every driver. Fixed by switching to
`reply.raw.on("close", ...)`, guarded so it doesn't re-fire after a normal
response completes.

## Quick start

**Single command (production-style — one process, one port):**

```bash
pnpm install
pnpm approve-builds better-sqlite3 esbuild   # one-time, compiles the native sqlite binding
npx .
```

This builds the frontend on first run (subsequent starts skip that), then
starts the server, which serves both the API and the built frontend from
the same port (`http://localhost:4000` by default — set `PORT` to change
it) and opens your browser automatically (set `DB_VIEWER_NO_OPEN=1` to skip
that). Once published to npm, the same experience will be `npx db-viewer`.
Ctrl+C shuts everything down cleanly, including every open database
connection (see the plugin system below).

**Two-terminal dev workflow** (hot reload on both sides):

```bash
pnpm install
pnpm approve-builds better-sqlite3 esbuild   # one-time, compiles the native sqlite binding

# terminal 1
pnpm dev:server   # Fastify on :4000

# terminal 2
pnpm dev:web      # Vite on :5173, proxies /api and /ws to :4000
```

Either way, connect to a SQLite file (or any of the other 5 drivers) and
browse.

## Keyboard support

- **Ctrl/⌘ K** — command palette: jump to any view, switch connection or
  table, without touching the mouse
- **?** — keyboard shortcuts help (suppressed while typing in a text field,
  since `?` is a normal character there)
- **Data grid** — arrow keys move the focused cell (scrolling virtualized
  rows into view as needed), Enter opens it for editing, Escape cancels,
  Delete/Backspace deletes the focused row (still behind a confirm)
- **SQL editor** — Ctrl/⌘ Enter runs the query
- Every dialog (new row, widget create/edit, command palette, shortcuts
  help) traps Tab focus inside itself, closes on Escape, and returns focus
  to whatever opened it — built on one shared `Modal` wrapper
  (`components/ui/modal.tsx`) rather than repeated per dialog

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

## Realtime — how it works

`apps/server/src/table-events.ts` is an in-process pub/sub bus keyed by
`(connectionId, table)`. Every insert/update/delete route publishes an event
there after a successful write; the `/ws/connections/:id/tables/:table/watch`
WebSocket route subscribes clients to it. The frontend's `useTableRows` hook
applies incoming events idempotently (matched by primary key, not array
position), so a client's own optimistic update and the server's echo of that
same change never double-apply or conflict — verified with a duplicate-event
test that confirms re-applying the same insert/update/delete is a no-op.

This catches every change made *through the app itself*, across any number
of open tabs or users — confirmed by connecting two simultaneous WebSocket
watchers and verifying both receive the same event from a single mutation.
MongoDB additionally uses native Change Streams (`DriverConnection.watchTable`,
an optional interface method only Mongo implements) so it also picks up
writes made outside the app — e.g. directly in `mongosh`. The other four
drivers don't have an equivalent low-effort mechanism: real CDC would mean
logical replication + triggers for Postgres, binlog streaming for MySQL, or
keyspace notifications for Redis, each a substantial separate feature.

## Dashboards & embedding — how the security model works

A dashboard is a grid of **widgets**, each a saved chart config (connection +
table + chart type + x/y fields + aggregation). The important part is how
embedding stays safe: enabling embedding generates a random `shareToken` for
that dashboard, and the public routes (`/api/public/dashboards/:id`,
`/api/public/dashboards/:id/widgets/:widgetId/data`) require it — but even
with a valid token, those routes only ever **replay the widget's pre-saved
query**. There is no way to pass arbitrary SQL, table names, or column names
through the public API; every column a widget references was validated
against the table's real schema at creation time (`chart-query.ts`), and
that's the only query that can ever run for that widget. Disabling embedding
regenerates/clears the token, immediately invalidating any link that was
shared.

Dashboard charting currently only supports Postgres, MySQL, and SQLite —
Mongo/Redis charting would need a different query-building approach and
isn't implemented yet.

## Adding a new database driver

1. `packages/drivers/<name>/` — new package implementing `DatabaseDriver` from
   `@pilaniaanand/driver-interface`.
2. Register it in `apps/server/src/registry.ts` — one line.

Nothing else changes. The server, the connection store, and every frontend
component only ever talk to the shared interface.

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
