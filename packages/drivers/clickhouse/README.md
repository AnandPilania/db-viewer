# @pilaniaanand/driver-clickhouse

ClickHouse driver for [db-viewer](https://github.com/pilaniaanand/db-viewer),
implementing `DatabaseDriver` from `@pilaniaanand/driver-interface`. Talks to
ClickHouse's HTTP interface directly via `fetch` — no client library
dependency, since the protocol is simple enough (plain SQL in,
JSON/JSONEachRow out) that one isn't needed.

## Install

```bash
npm install @pilaniaanand/driver-clickhouse
```

(Or via db-viewer's own driver manager: `db-viewer driver add clickhouse`.)

## Connecting

Standard `host`/`port`/`database`/`username`/`password` (over plain HTTP —
this driver doesn't currently support ClickHouse's HTTPS interface).
`readOnly: true` blocks every write through this connection at the server
layer.

## ClickHouse-specific realities this driver handles

- **UInt64/Int64 values** come back from the HTTP interface as JSON
  *strings*, not numbers, to avoid silent precision loss (JS numbers can't
  exactly represent the full 64-bit range) — passed through as-is, including
  in keyset cursors, where the pk column's known type decides whether to
  emit a bare numeral or a quoted string literal.
- **UPDATE/DELETE are asynchronous mutations** (`ALTER TABLE ... UPDATE`/
  `DELETE`), not transactional the way a row-store's UPDATE is — MergeTree is
  an append/merge-oriented columnar engine, not built for row-level OLTP. A
  read immediately after a write may not reflect it yet; this is standard
  ClickHouse behavior, not a bug in this driver.
- **No prepared statements.** ClickHouse's HTTP interface takes a single SQL
  string with no separate parameter binding, so values are literal-embedded
  with escaping (`toLiteral` — backslash and quote escaping matching
  ClickHouse's string-literal grammar) rather than placeholders.

## What this driver supports

- Keyset pagination via tuple comparison, never `OFFSET`.
- `count()` for both the fast estimate and the exact count — cheap on a
  columnar MergeTree table since it doesn't need to materialize full rows.
- Streaming query results via `JSONEachRow` over a `fetch` response body
  reader, so large results and CSV/NDJSON export never buffer in memory.
- **Live updates via poll-and-diff.** ClickHouse has no trigger/CDC mechanism
  at all (it's OLAP, not OLTP) — poll-and-diff on a 2-second interval is the
  only option, bounded to the first 1000 rows per poll. Because UPDATE/DELETE
  are async mutations, changes from those may lag behind the poll by more
  than one interval — that's ClickHouse's own behavior surfacing through the
  polling, not a bug in it.

## Identifier safety

Every database/table/column name that reaches this driver from a structured
request (not the free-form SQL editor) is validated with
`assertSafeIdentifier` before being interpolated into a backtick-quoted
identifier — this driver has no parameter-binding mechanism for identifiers
*or* values, so this validation is the entire injection defense on the
structured-operation side (`toLiteral` handles the value side).

## Known limitations

- Poll-based watching only sees the current top N rows, and per the async-
  mutation note above, can lag noticeably behind a DELETE/UPDATE mutation
  actually completing.
- Dashboard chart widgets against ClickHouse use the same literal-embedding
  as this driver (verified against injection attempts) rather than real
  parameter binding, since none is available.
