# @pilaniaanand/driver-redis

Redis driver for [db-viewer](https://github.com/pilaniaanand/db-viewer),
implementing `DatabaseDriver` from `@pilaniaanand/driver-interface` on top of
the official [`redis`](https://www.npmjs.com/package/redis) client.

## Install

```bash
npm install @pilaniaanand/driver-redis
```

(Or via db-viewer's own driver manager: `db-viewer driver add redis`.)

## Connecting

`host`/`port`/`password`, `database` as the numeric DB index (default `0`),
or a full connection string via `extra.uri`. `readOnly: true` blocks every
write through this connection at the server layer.

## Adapting Redis to a tabular contract

Redis has no tables or columns — this driver maps it as follows:

- **"table" = Redis key type** (`string`/`hash`/`list`/`set`/`zset`/
  `stream`) — six pseudo-tables, one per type.
- **One row per key** of that type, with a bounded value preview (Redis
  values can be arbitrarily large; this driver doesn't materialize a whole
  list/set/hash into a grid cell) and its TTL.
- **Pagination reuses Redis's own `SCAN` cursor directly** as db-viewer's
  pagination cursor — no translation layer, no `OFFSET`-equivalent.

The query editor's `redis-command` language sends a raw command + args
(`["SET", "foo", "bar"]`) for anything beyond browsing.

## What this driver supports

- **Live updates via real keyspace notifications** — enables
  `notify-keyspace-events` (`KEA`) on the server and subscribes via pub/sub,
  so external writes (another application, `redis-cli`, a different service)
  show up as live updates too. If the server denies `CONFIG SET` (some
  managed Redis providers lock this down), this fails gracefully — you still
  get app-originated events via the WebSocket broadcast layer, just not the
  external-write kind.
- **Restores the server's prior `notify-keyspace-events` value on close** —
  this driver reads and remembers whatever was configured before enabling
  its own notifications, and puts it back rather than leaving the server's
  keyspace-notification setting permanently changed after db-viewer
  disconnects.

## Known limitations

- **A brand-new key surfaces as an ignorable "update," not an "insert."**
  Redis keyspace notifications don't distinguish "this key is new" from
  "this key already existed and changed" — both fire the same event. The
  practical effect: a genuinely new key won't appear in an already-open grid
  until the table is next reloaded/scrolled, since inserting a synthetic row
  without knowing the client's current page state risks putting it in the
  wrong place. A delete-type event (`del`/`expired`/`evicted`) has no
  reliable type info either, so it's broadcast to every currently-watched
  pseudo-table — harmless, since the frontend only removes a row if one with
  that key is actually loaded.
- No chart/dashboard support beyond `number`/`table` widgets — there's no
  groupable field across independent keys, so bar/line/pie chart types are
  explicitly rejected for Redis rather than faked.
