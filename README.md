<img src="docs/logo.svg" alt="" width="72" />

# db-viewer

[![npm](https://img.shields.io/npm/v/@pilaniaanand/db-viewer)](https://www.npmjs.com/package/@pilaniaanand/db-viewer)
[![node](https://img.shields.io/node/v/@pilaniaanand/db-viewer)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@pilaniaanand/db-viewer)](LICENSE)

Browse, query, and chart Postgres, MySQL, SQLite, MongoDB, Redis, and
ClickHouse from a single local web UI.

It runs as one Node process that serves both the API and the UI, keeps its
connection list on your own disk, and is built for tables large enough that
`OFFSET` and `SELECT COUNT(*)` are not options.

## Install

Requires Node `^20.19` or `>=22.12`.

```bash
npx @pilaniaanand/db-viewer
```

Database drivers are installed separately, so you only pay for the ones you
use — some of them (SQLite in particular) compile native bindings:

```bash
npx @pilaniaanand/db-viewer driver add postgres
```

`driver list` shows what is installed, `driver remove <name>` uninstalls.
Drivers live in `~/.db-viewer/drivers`, independent of your current
directory.

The server starts on <http://localhost:4000> and opens a browser. Set `PORT`
to change the port, `DB_VIEWER_NO_OPEN=1` to keep the browser closed.

## Supported databases

| Database   | Driver package                      | Query language | Charts | External-write realtime |
| ---------- | ----------------------------------- | -------------- | ------ | ----------------------- |
| PostgreSQL | `@pilaniaanand/driver-postgres`     | SQL            | Yes    | Yes — trigger + `pg_notify`, installed on first watch |
| MySQL      | `@pilaniaanand/driver-mysql`        | SQL            | Yes    | No — would need binlog replication |
| SQLite     | `@pilaniaanand/driver-sqlite`       | SQL            | Yes    | No |
| ClickHouse | `@pilaniaanand/driver-clickhouse`   | SQL            | Yes    | No |
| MongoDB    | `@pilaniaanand/driver-mongodb`      | JSON pipelines | Yes    | Yes — native change streams |
| Redis      | `@pilaniaanand/driver-redis`        | Commands       | `number` and `table` only | Yes — keyspace notifications |

Writes made *through the app* broadcast to every other open client for all
six drivers. The "external-write realtime" column is about changes made
outside it — `psql`, `mongosh`, `redis-cli`, another service.

Redis maps its key types onto the tabular contract: each of the six types is
a pseudo-table, one row per key, with a bounded value preview, and Redis's
own `SCAN` cursor is reused as the pagination cursor. There is no groupable
field across keys, so grouped chart types are rejected rather than faked.

## Features

**Browsing.** Schema sidebar, virtualized data grid, inline cell editing,
row insert and delete, ER diagrams with automatic layout, and streaming
CSV/NDJSON export.

**Filtering.** The grid has its own filter builder, so narrowing a table
doesn't mean switching to the SQL tab and writing a query. Conditions combine
with AND or OR and nest into groups, giving you `a AND (b OR c)` without SQL.
Operators: the six comparisons, `between`, `contains` / `doesn't contain` /
`starts with` / `ends with` (wildcards supplied and your own `%` escaped),
raw `like` / `not like`, `in` / `not in`, and null checks.

Filters compile to a `WHERE` clause on the same keyset-paginated request the
grid already makes, so they run in the database rather than over loaded rows
and stay just as cheap on a huge table. Each driver binds the values;
ClickHouse, which has no binder, escapes them as literals. Redis honours only
a `key like` condition — SCAN takes one glob and nothing else. Export ignores
filters and writes the whole table.

**Querying.** Monaco editor with schema-aware autocompletion. Queries run
over a WebSocket and stream rows back as the cursor produces them, so
nothing buffers a full result set — on the server or in the browser.

**Dashboards.** Saved widgets (bar, line, area, scatter, pie, single number,
table/pivot) on a drag-and-resize grid. Each widget carries filters across
ten operators, optional calendar bucketing of a date axis by
day/week/month/quarter/year, a sort field and direction, a row cap, and
conditional highlight rules. Widgets refetch immediately when their
underlying table changes rather than waiting out a poll interval.

**Embedding.** A dashboard can be published behind a random share token.
Public routes only ever replay a widget's saved query — there is no way to
pass SQL, table names, or column names through them, and every column was
validated against the live schema when the widget was saved. The embed's
realtime channel sends a content-free "changed" ping, never row data or
which table a widget reads.

**Large tables.** Every browse request uses keyset pagination on the primary
key, so page 10,000 costs what page 10 costs. Row counts come from database
statistics by default; an exact count is a separate, cancellable request.
The grid mounts only the rows in the viewport and holds a bounded window of
pages in memory, so a long scroll stays flat rather than growing. Cancelling
a browse or a count kills the underlying database query, not just the HTTP
request.

**Keyboard.** `Ctrl/⌘ K` opens a command palette over views, connections, and
tables; `?` lists shortcuts. Arrow keys move the focused grid cell, Enter
edits, `Ctrl/⌘ Enter` runs the SQL editor. Every dialog traps focus, closes
on Escape, and restores focus to whatever opened it.

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` / `HOST` | `4000` / `localhost` | Listen address |
| `DB_VIEWER_HOME` | `~/.db-viewer` | Where installed drivers live |
| `DB_VIEWER_NO_OPEN` | unset | Set to skip opening a browser |
| `DB_VIEWER_READ_ONLY` | unset | `true` blocks every write on every connection |
| `DB_VIEWER_SECRET_KEY` | unset | 64 hex chars; key for encrypting saved passwords |
| `DB_VIEWER_SECRET_KEY_FILE` | unset | Path to a file holding the same, for secret mounts |
| `DB_VIEWER_ALLOWED_ORIGINS` | localhost only | Comma-separated extra origins; `*` allowed but warns |
| `DB_VIEWER_EMBED_TOKEN_TTL_DAYS` | `30` | Share-token lifetime; `0` for non-expiring |
| `DB_VIEWER_AUDIT_VALUES` | unset | `true` records full before/after values in the audit log |
| `LOG_LEVEL` | `info` | Pino log level |

Individual connections can also be marked read-only, and can reach a
database behind a bastion through a built-in SSH tunnel.

## Security

This is a local tool by default. There is no authentication in front of the
API — the CORS policy allows localhost and nothing else unless you say
otherwise, and that is the only thing standing between the API and anyone
who can reach the port.

Saved connection passwords are encrypted at rest with AES-256-GCM. Without
`DB_VIEWER_SECRET_KEY`/`_FILE` the key is generated on first run and stored
next to the ciphertext in `.data/secret.key`, which protects nothing against
someone who can read the directory; the server warns when it does this.
Supply a key from a secrets manager for anything shared.

Writes are recorded to an append-only audit log under `logs/`, separate from
the application log. Values are summarized rather than recorded verbatim
unless `DB_VIEWER_AUDIT_VALUES=true`.

The strongest available guarantee is not in this app: connect with a
database role that only has `SELECT`, or point it at a read replica.

## Development

pnpm workspace. `apps/server` is Fastify 5, `apps/web` is React + Vite +
Tailwind, `packages/driver-interface` holds the `DatabaseDriver` contract
every driver implements, and `packages/drivers/*` are the implementations.

```bash
pnpm install
pnpm dev          # server on :4000, Vite on :5173 proxying /api and /ws
pnpm test         # vitest
pnpm typecheck
pnpm build
```

`pnpm dev:server` and `pnpm dev:web` run the two halves separately.

### Adding a driver

1. Create `packages/drivers/<name>/` implementing `DatabaseDriver` from
   `@pilaniaanand/driver-interface`.
2. Register it in `apps/server/src/registry.ts`.

Nothing else changes — the server, the connection store, and every frontend
component talk only to the shared interface.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks a PR needs to
pass, and what adding a driver involves.

## License

[MIT](LICENSE) © Anand Pilania
