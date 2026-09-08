# @pilaniaanand/driver-mongodb

MongoDB driver for [db-viewer](https://github.com/pilaniaanand/db-viewer),
implementing `DatabaseDriver` from `@pilaniaanand/driver-interface` on top of
the official [`mongodb`](https://www.npmjs.com/package/mongodb) driver.

## Install

```bash
npm install @pilaniaanand/driver-mongodb
```

(Or via db-viewer's own driver manager: `db-viewer driver add mongodb`.)

## Connecting

`host`/`port`/`username`/`password`/`database`, or a full connection string
via `extra.uri` (useful for Atlas SRV URIs, replica sets, or any option this
driver doesn't expose a dedicated field for). `readOnly: true` blocks every
write through this connection at the server layer.

MongoDB has no schema/table split — collections are treated as db-viewer's
"tables" directly.

## Query language

MongoDB is the one non-SQL driver with genuine query power beyond simple
filtering: the query editor accepts either a `find()` shape
(`{ collection, filter, sort, limit }`) or a full aggregation
(`{ collection, pipeline }`). Writes (`execute()`) take an explicit `op`:
`insertOne`/`updateOne`/`deleteOne`/`deleteMany`.

## What this driver supports

- `_id`-based keyset pagination (`_id > lastId`, never `skip()`).
- Streaming query results via a real MongoDB cursor with `batchSize`, so
  large results and CSV/NDJSON export never buffer in memory.
- **Real CDC via native Change Streams** — `watchTable` opens a genuine
  MongoDB Change Stream, so external writes (another application, `mongosh`,
  a different service sharing the database) show up as live updates too, not
  just changes made through db-viewer itself. Requires a replica set (or
  Atlas, which always is one); on a standalone server this gracefully no-ops
  instead of crashing the watch subscription — you still get app-originated
  live updates, just not the external-write kind.

## Known limitations

- Dashboard chart widgets against MongoDB build a validated aggregation
  pipeline (every field checked against the collection's real fields at
  widget-creation time) rather than accepting one directly from a public
  embed viewer — there is no way to pass arbitrary pipeline stages through
  the public API.
- No schema/index introspection beyond field names sampled from documents —
  Mongo has no fixed schema to read authoritatively.
