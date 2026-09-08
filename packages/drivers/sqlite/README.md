# @pilaniaanand/driver-sqlite

SQLite driver for [db-viewer](https://github.com/pilaniaanand/db-viewer),
implementing `DatabaseDriver` from `@pilaniaanand/driver-interface` on top of
[`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3).

## Install

```bash
npm install @pilaniaanand/driver-sqlite
```

(Or via db-viewer's own driver manager: `db-viewer driver add sqlite`.)
Requires a native binding — `better-sqlite3` compiles on install, which
needs a C++ toolchain unless a prebuilt binary is available for your
platform/Node version.

## Connecting

File-based — just `filePath` (or `:memory:`). No host/port/credentials/TLS.
`readOnly: true` blocks every write through this connection at the server
layer, independent of the file's own OS permissions.

The database is opened in WAL mode (`journal_mode = WAL`) for better
concurrent read performance.

## What this driver supports

- Single-column keyset pagination (`WHERE pk > ?`, never `OFFSET`); falls
  back to SQLite's own `rowid` when a table has no declared primary key.
- `MAX(rowid)` as a fast row-count estimate (SQLite has no built-in
  statistics table); exact counts do a real `COUNT(*)`.
- Streaming query results via `better-sqlite3`'s `.iterate()`, so large
  results and CSV/NDJSON export never buffer in memory.
- **Live updates via poll-and-diff.** SQLite's own change-notification
  mechanism (`update_hook`) is per-connection and in-process only — it can't
  see writes from another connection or process touching the same file, so
  it wouldn't catch anything but db-viewer's own writes anyway. Instead this
  driver polls `PRAGMA data_version` (a counter SQLite itself maintains,
  incremented by *any* connection's write to the file) on a 1-second
  interval — genuinely cross-process — and only pays for a full re-query and
  diff when that counter has actually moved. Bounded to the first 1000 rows
  per poll.

## Identifier safety

Every table/column name that reaches this driver from a structured request
(not the free-form SQL editor) is validated with `assertSafeIdentifier`
before being interpolated into a query string — this includes `PRAGMA
table_info("...")`/`PRAGMA foreign_key_list("...")`, which SQLite has no
parameter-binding mechanism for at all. Values are always parameterized
(`?`).

## Known limitations

- Poll-based watching only sees the current top N rows of a table.
- `better-sqlite3`'s synchronous API means a single slow query blocks the
  Node event loop for its duration — fine for a browsing tool, not
  appropriate for a high-concurrency server workload.
