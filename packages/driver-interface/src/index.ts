/**
 * @pilaniaanand/driver-interface
 *
 * This is the single contract every database adapter implements. The registry
 * (apps/server) only ever talks to this interface — it never imports a
 * concrete driver directly. Adding support for a new database means writing
 * one new package that implements `DatabaseDriver` and registering it; no
 * other part of the system changes.
 *
 * Design rules baked into this contract (see architecture plan):
 *  - Nothing here returns a full result set. Reads are either paginated
 *    (`queryRows`) or streamed (`streamQuery`), so a caller can never
 *    accidentally materialize a trillion-row table in memory.
 *  - Row counts are explicitly split into a fast estimate and a slow exact
 *    count, so the UI can show something instantly and let the user opt in
 *    to the expensive version.
 *  - Everything long-running is cancellable via an AbortSignal.
 */

export type QueryLanguage = "sql" | "mongo" | "redis-command";

export type ColumnType =
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "json"
    | "binary"
    | "null"
    | "unknown";

export interface ColumnDefinition {
    name: string;
    type: ColumnType;
    nativeType: string; // e.g. "varchar(255)", "int4", "ObjectId"
    nullable: boolean;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
    references?: { table: string; column: string };
    defaultValue?: string | null;
}

export interface TableDefinition {
    schema?: string; // e.g. postgres schema, mysql database — omit if not applicable
    name: string;
    kind: "table" | "view" | "collection" | "materialized_view";
    columns: ColumnDefinition[];
    estimatedRowCount?: number; // from DB statistics, may be stale
}

export interface SchemaSummary {
    name: string;
    tables: Array<Pick<TableDefinition, "schema" | "name" | "kind">>;
}

/** TLS options for connecting directly to a database that requires (or accepts) certificate-based auth. */
export interface SslConfig {
    enabled: boolean;
    rejectUnauthorized?: boolean; // default true; set false only for self-signed certs you trust out-of-band
    ca?: string; // PEM contents of the CA certificate
    cert?: string; // PEM contents of the client certificate
    key?: string; // PEM contents of the client private key
}

/**
 * Connects to `host`/`port` through an SSH server first — the standard way
 * to reach a database sitting in a private subnet behind a bastion/jump
 * host (e.g. AWS RDS). `privateKey` accepts OpenSSH PEM or PuTTY PPK
 * contents; ssh2 auto-detects the format.
 */
export interface SshTunnelConfig {
    enabled: boolean;
    host: string;
    port?: number; // default 22
    username: string;
    privateKey?: string; // PEM or PPK contents, pasted or uploaded
    passphrase?: string; // for an encrypted privateKey
    password?: string; // alternative to privateKey
}

export interface ConnectionConfig {
    id: string;
    driver: string; // registry key, e.g. "postgres", "mysql", "sqlite", "mongodb"
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    filePath?: string; // for file-based drivers like sqlite
    ssl?: boolean | SslConfig; // boolean is a plain "use TLS" toggle; SslConfig adds client-cert auth
    sshTunnel?: SshTunnelConfig;
    /**
     * App-level safety net: when true, every write/DDL operation against this
     * connection is rejected before it reaches the driver — insertRow/
     * updateCell/deleteRow outright, and execute() for any query whose intent
     * isn't a plain read (see isDestructiveExec). This is enforced by the
     * server (routes/connections.ts), not by individual drivers.
     *
     * This is a UX/compliance safety net, not a substitute for real access
     * control — a connection string with write privileges can still write if
     * something reaches the underlying client directly. For a guarantee that
     * survives an application bug, connect with a database role that only
     * has SELECT granted (or point this at a read replica) — that's the one
     * layer this app cannot bypass no matter what.
     */
    readOnly?: boolean;
    extra?: Record<string, unknown>; // driver-specific overflow (e.g. mongo replica set opts)
}

/** Normalizes the two `ssl` shapes drivers can receive into one, or undefined if TLS isn't requested. */
export function resolveSsl(ssl: ConnectionConfig["ssl"]): SslConfig | undefined {
    if (!ssl) return undefined;
    if (ssl === true) return { enabled: true };
    return ssl.enabled ? ssl : undefined;
}

/**
 * Matches a bare SQL identifier: letters/digits/underscore, not starting
 * with a digit. SQL has no parameterized-identifier mechanism the way it
 * does for values (no driver supports `WHERE $1 = $2` binding a column
 * name) — every SQL driver's structured operations (queryRows filters,
 * insertRow/updateCell/deleteRow column names, the table/schema name
 * itself) must run every client-supplied identifier through
 * `assertSafeIdentifier` before interpolating it into a query string.
 * Rejecting anything outside this charset closes identifier-based SQL
 * injection outright — no quote, backtick, semicolon, or comment sequence
 * can ever reach the query text.
 */
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeIdentifier(name: string, kind: string): void {
    if (typeof name !== "string" || !SAFE_SQL_IDENTIFIER.test(name)) {
        throw new Error(`Invalid ${kind} name: ${JSON.stringify(name)}`);
    }
}

export interface CursorPage {
    /** Opaque, driver-defined cursor. Callers must not parse this string. */
    cursor: string | null;
}

export interface QueryRowsOptions {
    table: string;
    schema?: string;
    columns?: string[]; // omit for all columns
    filters?: QueryFilter[];
    sort?: { column: string; direction: "asc" | "desc" }[];
    pageSize: number;
    afterCursor?: string | null; // keyset pagination — never OFFSET
    signal?: AbortSignal;
}

export interface QueryFilter {
    column: string;
    op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "in" | "is_null" | "is_not_null";
    value?: unknown;
}

/** Emitted by drivers that support native change notification (see DriverConnection.watchTable). */
export interface RowChangeEvent {
    type: "insert" | "update" | "delete";
    row?: Record<string, unknown>; // present for insert
    primaryKey?: Record<string, unknown>; // present for update/delete
    column?: string; // present for update
    value?: unknown; // present for update
}

/**
 * Shared building block for drivers with no native change feed: given two
 * full-table snapshots and the table's primary key columns, produces the
 * same RowChangeEvent shape a native watcher would emit. A changed row is
 * reported as a single "__row__" update (see useTableRows.ts) rather than
 * diffed field-by-field — the snapshot doesn't tell us which columns moved,
 * only that the row did.
 */
export function diffTableSnapshots(
    prevRows: Record<string, unknown>[],
    currRows: Record<string, unknown>[],
    pkColumns: string[]
): RowChangeEvent[] {
    const keyOf = (row: Record<string, unknown>) => JSON.stringify(pkColumns.map((c) => row[c]));
    const pkOf = (row: Record<string, unknown>) => Object.fromEntries(pkColumns.map((c) => [c, row[c]]));
    const prevByKey = new Map(prevRows.map((r) => [keyOf(r), r]));
    const currByKey = new Map(currRows.map((r) => [keyOf(r), r]));
    const events: RowChangeEvent[] = [];

    for (const [key, row] of currByKey) {
        const prevRow = prevByKey.get(key);
        if (!prevRow) events.push({ type: "insert", row });
        else if (JSON.stringify(prevRow) !== JSON.stringify(row)) {
            events.push({ type: "update", primaryKey: pkOf(row), column: "__row__", value: row });
        }
    }
    for (const [key, row] of prevByKey) {
        if (!currByKey.has(key)) events.push({ type: "delete", primaryKey: pkOf(row) });
    }
    return events;
}

export interface QueryRowsResult {
    rows: Record<string, unknown>[];
    nextCursor: string | null; // null => no more rows
    columns: ColumnDefinition[];
}

export interface RowCountEstimate {
    value: number;
    exact: false;
    source: "statistics" | "unsupported";
}

export interface RowCountExact {
    value: number;
    exact: true;
}

/**
 * A read query in whatever shape the target driver's queryLanguage expects,
 * used by streamQuery(). Discriminated on `language` so each driver's
 * implementation only has to handle the one variant matching its own
 * `capabilities.queryLanguage` — TypeScript rejects the others at compile
 * time, and callers (the query editor UI, the stream route) never need to
 * guess or JSON.parse a string to figure out what they're holding.
 */
export type RedisKeyType = "string" | "hash" | "list" | "set" | "zset" | "stream";

export type QuerySpec =
    | { language: "sql"; sql: string; params?: unknown[] }
    | {
        language: "mongo";
        collection: string;
        /** Either a find() (filter/sort/limit) or an aggregate() (pipeline) — not both. */
        filter?: Record<string, unknown>;
        sort?: Record<string, 1 | -1>;
        limit?: number;
        pipeline?: Record<string, unknown>[];
    }
    | {
        language: "redis-command";
        /** Browse keys of one type (SCAN under the hood) — see DriverConnection.queryRows for the "table" equivalent. */
        type: RedisKeyType;
        pattern?: string;
        limit?: number;
    };

/**
 * A write/DDL query for execute(). Separate from QuerySpec because a
 * driver's write shape can genuinely differ from its read shape (e.g.
 * MongoDB reads via filter/sort/pipeline but writes via an explicit
 * op + filter/update/doc) — forcing them into one type would leave unused
 * fields on one side or the other.
 */
export type ExecSpec =
    | { language: "sql"; sql: string; params?: unknown[] }
    | {
        language: "mongo";
        op: "insertOne" | "updateOne" | "deleteOne" | "deleteMany";
        collection: string;
        filter?: Record<string, unknown>;
        update?: Record<string, unknown>;
        doc?: Record<string, unknown>;
    }
    | {
        language: "redis-command";
        /** Raw write command + args, e.g. ["SET", "foo", "bar"] or ["DEL", "foo"]. */
        command: string[];
    };

export interface StreamQueryOptions {
    query: QuerySpec;
    chunkSize?: number; // rows per emitted chunk, default driver-defined
    signal?: AbortSignal;
}

const SQL_SAFE_LEADING_KEYWORDS = new Set(["select", "with", "explain", "show", "describe", "desc", "pragma", "values"]);
// Whole-word scan for write/DDL verbs anywhere in the statement — catches a
// write smuggled inside a CTE (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`),
// which a leading-keyword check alone would miss.
const SQL_WRITE_VERB = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|call|copy|vacuum|reindex|lock|replace|into\s+outfile)\b/i;

const REDIS_SAFE_READ_COMMANDS = new Set([
    "get", "mget", "strlen", "getrange", "exists", "type", "ttl", "pttl", "scan", "keys", "dbsize",
    "hget", "hmget", "hgetall", "hkeys", "hvals", "hlen", "hrandfield", "hexists", "hscan", "hstrlen",
    "lrange", "llen", "lindex", "lpos",
    "smembers", "scard", "sismember", "smismember", "srandmember", "sscan", "sinter", "sunion", "sdiff",
    "zrange", "zrangebyscore", "zrevrange", "zrevrangebyscore", "zscore", "zmscore", "zcard", "zcount",
    "zrank", "zrevrank", "zscan",
    "xrange", "xrevrange", "xlen", "xread",
    "ping", "echo", "info", "time", "config", "client", "object", "memory", "randomkey", "touch",
]);

/**
 * True if this write/DDL/execute request should be blocked when the
 * connection is read-only. Deliberately fails closed: for SQL, anything not
 * lexically recognizable as a plain read is treated as destructive; for
 * Mongo, execute() only ever carries write ops (reads go through
 * queryRows), so it's always destructive; for Redis, only a fixed allowlist
 * of read commands is permitted.
 */
export function isDestructiveExec(query: ExecSpec): boolean {
    if (query.language === "mongo") return true;
    if (query.language === "redis-command") {
        const cmd = query.command[0]?.toLowerCase();
        return !cmd || !REDIS_SAFE_READ_COMMANDS.has(cmd);
    }
    // SQL
    const statements = query.sql
        .replace(/--[^\n]*/g, " ") // line comments
        .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    if (statements.length !== 1) return true; // no legitimate read needs multiple statements
    const stmt = statements[0];
    const leading = stmt.match(/^[A-Za-z]+/)?.[0]?.toLowerCase();
    if (!leading || !SQL_SAFE_LEADING_KEYWORDS.has(leading)) return true;
    return SQL_WRITE_VERB.test(stmt);
}

export interface QueryExecResult {
    columns: ColumnDefinition[];
    affectedRows?: number;
    durationMs: number;
}

/**
 * The contract. All methods are async / async-iterable so a driver can wrap
 * a network call, a local file read, or an in-process embedded engine
 * identically from the registry's point of view.
 */
export interface DatabaseDriver {
    readonly key: string; // registry key, must match ConnectionConfig.driver
    readonly displayName: string;
    readonly capabilities: {
        transactions: boolean;
        schemas: boolean; // does this DB have a schema/namespace concept above "table"?
        streaming: boolean;
        cancellation: boolean;
        queryLanguage: QueryLanguage; // what shape of query streamQuery()/execute() expect — drives the UI's editor mode
    };

    testConnection(config: ConnectionConfig): Promise<{ ok: boolean; message?: string }>;

    connect(config: ConnectionConfig): Promise<DriverConnection>;
}

export interface DriverConnection {
    readonly id: string;

    listSchemas(): Promise<SchemaSummary[]>;
    listTables(schema?: string): Promise<TableDefinition[]>;
    describeTable(table: string, schema?: string): Promise<TableDefinition>;

    /** Keyset-paginated row browsing for the data grid. Never uses OFFSET. */
    queryRows(options: QueryRowsOptions): Promise<QueryRowsResult>;

    /** Inserts a new record. Returns the inserted row as the driver sees it (with any DB-generated defaults filled in). */
    insertRow(table: string, schema: string | undefined, values: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Deletes the record(s) matching every column in primaryKey. */
    deleteRow(table: string, schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void>;

    /**
     * Optional: subscribe to native change notifications for a table (e.g.
     * MongoDB Change Streams). Only implemented by drivers whose database
     * supports this without extra setup (triggers, replication config,
     * etc). Returns an unsubscribe function. Callers must call it exactly
     * once when no longer interested — drivers that implement this should
     * treat it as a reference-counted resource internally if needed.
     */
    watchTable?(
        table: string,
        schema: string | undefined,
        onChange: (event: RowChangeEvent) => void
    ): () => void;

    /** Fast, approximate — reads DB statistics, not a full scan. */
    estimateRowCount(table: string, schema?: string): Promise<RowCountEstimate>;

    /** Slow, exact — an opt-in COUNT(*) style scan. Must respect signal. */
    countRowsExact(table: string, schema?: string, signal?: AbortSignal): Promise<RowCountExact>;

    /** Arbitrary SQL/query execution for the query editor, streamed in chunks. */
    streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult>;

    /** Non-SELECT execution (INSERT/UPDATE/DELETE/DDL, a mongo write command, or a redis write command), also cancellable. */
    execute(query: ExecSpec, signal?: AbortSignal): Promise<QueryExecResult>;

    updateCell(
        table: string,
        schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void>;

    close(): Promise<void>;
}
