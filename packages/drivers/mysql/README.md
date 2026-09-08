# @pilaniaanand/driver-mysql

MySQL driver for [db-viewer](https://github.com/pilaniaanand/db-viewer),
implementing `DatabaseDriver` from `@pilaniaanand/driver-interface` on top of
[`mysql2`](https://www.npmjs.com/package/mysql2).

## Install

```bash
npm install @pilaniaanand/driver-mysql
```

(Or via db-viewer's own driver manager: `db-viewer driver add mysql`.)

## Connecting

Standard `host`/`port`/`database`/`username`/`password`, plus:

- **TLS**, including client-certificate auth — `ssl: true` for a plain
  toggle, or `ssl: { enabled: true, ca, cert, key, rejectUnauthorized }` with
  PEM contents pasted/uploaded directly.
- **SSH tunnel** for a database behind a bastion — `sshTunnel: { enabled: true, host, username, privateKey, passphrase }`,
  PEM or PPK. Handled by the server, not this driver.
- **`readOnly: true`** — blocks every write through this connection at the
  server layer.

MySQL has no schema concept above database/table (unlike Postgres) — the
connected database itself is treated as the single "schema".

## What this driver supports

- Cursor/keyset pagination with row-wise tuple comparison for correct
  multi-column primary keys, never `OFFSET`.
- Exact row counts are cancellable — cancelling issues `KILL QUERY` against
  the actual connection running it, not just the HTTP request.
- Streaming query results by dropping to `mysql2`'s underlying callback
  connection (the promise wrapper doesn't expose `.stream()`), so large
  results and CSV/NDJSON export never buffer in memory.
- **Live updates via poll-and-diff.** MySQL has no low-effort push mechanism
  short of binlog replication (real infrastructure, out of scope for a
  connect-and-browse tool), so watching a table polls it on a 1-second
  interval and diffs the snapshot by primary key, emitting the same
  insert/update/delete events a native watcher would. Bounded to the first
  1000 rows per poll so this stays cheap on large tables.

## Identifier safety

Every table/column name that reaches this driver from a structured request
(not the free-form SQL editor) is validated with `assertSafeIdentifier`
before being interpolated into a query string. Values are always
parameterized (`?`).

## Known limitations

- Poll-based watching only sees the current top N rows of a table — a change
  further down a huge table between polls can be missed if it falls outside
  the row limit both before and after.
- `multipleStatements` is not enabled on the connection pool, so a
  stacked-query injection attempt via a crafted identifier is blocked at the
  protocol level even before `assertSafeIdentifier` would reject it.
