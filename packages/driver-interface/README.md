# @pilaniaanand/driver-interface

The contract every [db-viewer](https://github.com/pilaniaanand/db-viewer) database
adapter implements. The server only ever talks to this interface — it never
imports a concrete driver directly. Adding support for a new database means
writing one package that implements `DatabaseDriver` and registering it; no
other part of the system changes.

This package ships types only, plus a handful of small runtime helpers that
every SQL driver shares (see below). It has no database client dependencies
of its own.

## The contract

```ts
interface DatabaseDriver {
    readonly key: string;          // registry key, e.g. "postgres"
    readonly displayName: string;
    readonly capabilities: {
        transactions: boolean;
        schemas: boolean;           // does this DB have a schema/namespace concept above "table"?
        streaming: boolean;
        cancellation: boolean;
        queryLanguage: "sql" | "mongo" | "redis-command";
    };

    testConnection(config: ConnectionConfig): Promise<{ ok: boolean; message?: string }>;
    connect(config: ConnectionConfig): Promise<DriverConnection>;
}

interface DriverConnection {
    listSchemas(): Promise<SchemaSummary[]>;
    listTables(schema?: string): Promise<TableDefinition[]>;
    describeTable(table: string, schema?: string): Promise<TableDefinition>;

    queryRows(options: QueryRowsOptions): Promise<QueryRowsResult>;      // keyset-paginated, never OFFSET
    estimateRowCount(table: string, schema?: string): Promise<RowCountEstimate>;
    countRowsExact(table: string, schema?: string, signal?: AbortSignal): Promise<RowCountExact>;

    insertRow(table: string, schema: string | undefined, values: Record<string, unknown>): Promise<Record<string, unknown>>;
    updateCell(table: string, schema: string | undefined, primaryKey: Record<string, unknown>, column: string, value: unknown): Promise<void>;
    deleteRow(table: string, schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void>;

    streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult>;
    execute(query: ExecSpec, signal?: AbortSignal): Promise<QueryExecResult>;

    watchTable?(table: string, schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void; // optional: live updates
    close(): Promise<void>;
}
```

Design rules baked into the contract:

- **Nothing returns a full result set.** Reads are paginated (`queryRows`) or
  streamed (`streamQuery`), so a caller can never accidentally materialize a
  huge table in memory.
- **Row counts are split into fast/slow.** `estimateRowCount` reads database
  statistics; `countRowsExact` is the real, explicit, cancellable thing.
- **Everything long-running takes an `AbortSignal`.**
- **`watchTable` is optional.** Only implemented by drivers with a low-effort
  way to detect changes — a native mechanism (Postgres trigger + `LISTEN`,
  MongoDB Change Streams, Redis keyspace notifications) or plain
  poll-and-diff (MySQL, SQLite, ClickHouse). See `diffTableSnapshots` below.

## Runtime helpers

Small, shared building blocks so every driver doesn't reimplement the same
logic:

- **`assertSafeIdentifier(name, kind)`** — throws unless `name` matches
  `^[A-Za-z_][A-Za-z0-9_]*$`. SQL has no bind-parameter mechanism for
  identifiers (table/column names) the way it does for values, so every SQL
  driver runs every client-supplied identifier through this before
  interpolating it into a query string. This is the actual SQL-injection
  defense for structured operations (`queryRows` filters, `insertRow`/
  `updateCell`/`deleteRow` column names, the table name itself).
- **`resolveSsl(ssl)`** — normalizes `ConnectionConfig.ssl`'s two shapes (a
  plain `boolean` toggle, or a full `SslConfig` with `ca`/`cert`/`key` for
  client-certificate auth) into one.
- **`diffTableSnapshots(prevRows, currRows, pkColumns)`** — compares two
  full-table snapshots by primary key and emits the same `RowChangeEvent`
  shape a native watcher would. The shared implementation behind every
  poll-based `watchTable`.
- **`isDestructiveExec(query)`** — used by the server's read-only enforcement
  (not by drivers themselves): true if an `ExecSpec` isn't recognizable as a
  plain read, failing closed for anything ambiguous (including a write
  smuggled inside a CTE).

## `ConnectionConfig`

```ts
interface ConnectionConfig {
    id: string;
    driver: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    filePath?: string;              // file-based drivers (sqlite)
    ssl?: boolean | SslConfig;      // TLS, optionally with client-cert auth
    sshTunnel?: SshTunnelConfig;    // reach a DB behind a bastion (PEM or PPK key)
    readOnly?: boolean;             // block every write through this connection
    extra?: Record<string, unknown>;
}
```

`sshTunnel` and `ssl`/`readOnly` are handled centrally by the server (opening
the tunnel before calling `driver.connect()`, enforcing `readOnly` before any
write route) — a driver package never needs to know about either.

## Adding a driver

1. New package implementing `DatabaseDriver`, depending on this package.
2. Register it in the server's `registry.ts` — one line.

Nothing else in the system changes.
