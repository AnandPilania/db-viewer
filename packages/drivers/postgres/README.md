# @pilaniaanand/driver-postgres

PostgreSQL driver for [db-viewer](https://github.com/pilaniaanand/db-viewer),
implementing `DatabaseDriver` from `@pilaniaanand/driver-interface` on top of
[`pg`](https://www.npmjs.com/package/pg) and
[`pg-cursor`](https://www.npmjs.com/package/pg-cursor).

## Install

```bash
npm install @pilaniaanand/driver-postgres
```

(Or via db-viewer's own driver manager: `db-viewer driver add postgres`.)

## Connecting

Standard `host`/`port`/`database`/`username`/`password`, plus:

- **TLS**, including client-certificate auth — `ssl: true` for a plain
  toggle, or `ssl: { enabled: true, ca, cert, key, rejectUnauthorized }` with
  PEM contents pasted/uploaded directly (no temp files).
- **SSH tunnel**, for an RDS/Cloud SQL instance sitting in a private subnet
  behind a bastion — `sshTunnel: { enabled: true, host, username, privateKey, passphrase }`.
  `privateKey` accepts OpenSSH PEM or PuTTY PPK contents; the format is
  auto-detected. Handled entirely by the server (it opens the tunnel and
  rewrites `host`/`port` before calling this driver), so nothing here is
  tunnel-aware.
- **`readOnly: true`** — blocks every write through this connection at the
  server layer, before any driver method runs.

## What this driver supports

- Cursor/keyset pagination (`WHERE (pk1, pk2, ...) > (v1, v2, ...)`, never
  `OFFSET`), including composite primary keys and a `ctid` fallback for
  tables with no primary key.
- Exact row counts are real, cancellable queries — cancelling calls
  `pg_cancel_backend` on the actual backend PID, not just aborting the HTTP
  request.
- Streaming query results via `pg-cursor`, so the SQL editor and CSV/NDJSON
  export never buffer a full result set in memory.
- **Real CDC.** On first watch of a table, this driver installs a trigger
  (`__dbviewer_watch`) and a shared function (`__dbviewer_notify_change`)
  that calls `pg_notify` on every row change, then `LISTEN`s on one shared
  channel for the whole connection — so external writes (`psql`, another
  application, a cron job) show up as live updates too, not just changes
  made through db-viewer itself. The trigger is dropped automatically when
  the connection closes.

  This trigger is defensive by design: `pg_notify`'s payload has a hard
  ~8000-byte limit, so a wide row (a large `text`/`jsonb`/encrypted-blob
  column) falls back to a row-less "something changed" signal instead of
  overflowing it, and the whole notify path is wrapped in
  `EXCEPTION WHEN OTHERS THEN NULL` — a bug in this mechanism can never abort
  the write that triggered it, whether that write came from db-viewer or any
  other application sharing the database.

## Identifier safety

Every table/schema/column name that reaches this driver from a structured
request (not the free-form SQL editor) is validated with
`assertSafeIdentifier` before being interpolated into a query string — SQL
has no bind-parameter mechanism for identifiers, so this is the actual
injection defense for `queryRows` filters and `insertRow`/`updateCell`/
`deleteRow`. Values are always parameterized (`$1`, `$2`, ...).

## Known limitations

- No schema-per-table watch limit — CDC is per (schema, table), so watching
  many tables installs many triggers (each cheap, but real DDL objects on
  your database).
- `sslmode=require`-only servers work via the plain `ssl: true` toggle;
  `verify-full` needs a CA cert supplied through `SslConfig.ca`.
