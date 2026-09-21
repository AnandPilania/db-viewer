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

export type ColumnType = "string" | "number" | "boolean" | "date" | "datetime" | "json" | "binary" | "null" | "unknown";

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
    /**
     * Opt in to change-data-capture that MODIFIES the target server to work.
     * Off by default, and deliberately so: on Postgres it means CREATE
     * FUNCTION + CREATE TRIGGER on the watched table (a schema change an
     * auditor will find, firing on every write from every application, not
     * just this one), and on Redis a server-global CONFIG SET that affects
     * every other client of that instance. Installing either into a customer
     * database without an explicit, recorded decision is a change-control
     * violation in most regulated environments.
     *
     * Left off, drivers fall back to read-only change detection: poll-and-diff
     * on Postgres, and on Redis a plain subscribe that picks up events if an
     * admin has already enabled keyspace notifications. Changes made through
     * this app are broadcast to every viewer either way.
     *
     * Ignored when `readOnly` is set.
     */
    installCdc?: boolean;
    /**
     * Opt-in mirror of `readOnly`: whether this connection's widgets may sit
     * on a dashboard alongside widgets from OTHER connections. Off by
     * default, because an embedded dashboard's share token grants read
     * access to every connection its widgets touch — mixing a scratch
     * database into the same dashboard as prod means one link now covers
     * both. A dashboard whose widgets all come from one connection is
     * unaffected either way.
     */
    allowMultiDbDashboards?: boolean;
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

/**
 * Resolves the ordering tuple for a keyset page: the requested sort columns
 * first, then any primary-key column not already among them.
 *
 * The primary-key tiebreaker is what makes keyset paging safe. Without it two
 * rows sharing a sort value have no stable relative order, so a page boundary
 * falling between them can skip rows or serve them twice.
 *
 * Every column takes the first sort entry's direction — keyset paging compares
 * the whole tuple in one operation, which is only valid when the tuple sorts
 * uniformly. See QueryRowsOptions.sort.
 */
export function resolveOrderBy(
    sort: { column: string; direction: "asc" | "desc" }[] | undefined,
    pkColumns: string[]
): { column: string; direction: "asc" | "desc" }[] {
    const direction: "asc" | "desc" = sort?.[0]?.direction === "desc" ? "desc" : "asc";
    const columns: string[] = [];
    for (const entry of sort ?? []) if (!columns.includes(entry.column)) columns.push(entry.column);
    for (const pk of pkColumns) if (!columns.includes(pk)) columns.push(pk);
    return columns.map((column) => ({ column, direction }));
}

/**
 * Builds the row-wise comparison that advances a keyset page:
 * `(a, b, pk) > (av, bv, pkv)`, which a database can drive straight off a
 * matching index — the reason a jump deep into a huge table stays cheap where
 * OFFSET would scan everything before it.
 *
 * `inclusive` distinguishes the two callers: a cursor continues *after* a
 * known row (exclusive), a seek lands *on* the first row at or past a value
 * (inclusive). Fewer values than columns is a valid prefix seek.
 *
 * Shared across the SQL drivers because getting the operator or the tuple
 * shape wrong produces silently-wrong pages, not an error.
 */
export function keysetComparison(
    orderColumns: string[],
    valueCount: number,
    opts: {
        descending: boolean;
        inclusive: boolean;
        /** Wraps an identifier for the target dialect (double quotes, backticks). */
        quote: (identifier: string) => string;
        /** Renders the nth (0-based) bound parameter: `$1`, `?`, ... */
        placeholder: (index: number) => string;
    }
): string {
    if (valueCount < 1) throw new Error("keysetComparison needs at least one value");
    if (valueCount > orderColumns.length) {
        throw new Error(`keysetComparison got ${valueCount} values for ${orderColumns.length} ordering columns`);
    }
    const used = orderColumns.slice(0, valueCount);
    const op = opts.descending ? (opts.inclusive ? "<=" : "<") : opts.inclusive ? ">=" : ">";
    const placeholders = used.map((_, i) => opts.placeholder(i));
    if (used.length === 1) return `${opts.quote(used[0])} ${op} ${placeholders[0]}`;
    return `(${used.map(opts.quote).join(", ")}) ${op} (${placeholders.join(", ")})`;
}

export interface CursorPage {
    /** Opaque, driver-defined cursor. Callers must not parse this string. */
    cursor: string | null;
}

export interface QueryRowsOptions {
    table: string;
    schema?: string;
    columns?: string[]; // omit for all columns
    /** AND-joined. Entries may be groups, so `a AND (b OR c)` is expressible. */
    filters?: FilterNode[];
    /**
     * Sort order. The table's primary key is always appended as a tiebreaker
     * so paging is deterministic even when the sort column has duplicates.
     *
     * All entries share one direction — the first entry's. Keyset pagination
     * compares the whole ordering tuple at once, which only works when every
     * column in it sorts the same way; honouring per-column directions would
     * mean an OR-chain of comparisons per column, and nothing asks for mixed
     * directions yet.
     */
    sort?: { column: string; direction: "asc" | "desc" }[];
    pageSize: number;
    afterCursor?: string | null; // keyset pagination — never OFFSET
    /**
     * Jump to a position by value instead of by cursor: leading ordering-column
     * values to start *at* (inclusive), where afterCursor starts *after*
     * (exclusive). This is how a viewer reaches row ~800 billion without an
     * OFFSET scan or a chain of cursor fetches — the caller supplies a sort-key
     * value and the database seeks the index straight to it.
     *
     * Fewer values than ordering columns is fine (a prefix seek). Ignored when
     * afterCursor is set, since a cursor is already a precise position.
     */
    seek?: unknown[] | null;
    signal?: AbortSignal;
}

export interface QueryFilter {
    column: string;
    op: FilterOperator;
    value?: unknown;
}

/**
 * `contains`/`starts_with`/`ends_with` are LIKE with the wildcards supplied
 * for you, and with any % or _ inside the user's own text escaped — typing
 * "50%" should search for "50%", not for "50 followed by anything".
 * `like`/`not_like` stay raw for people who want to write the pattern.
 */
export type FilterOperator =
    | "="
    | "!="
    | ">"
    | ">="
    | "<"
    | "<="
    | "like"
    | "not_like"
    | "contains"
    | "not_contains"
    | "starts_with"
    | "ends_with"
    | "in"
    | "not_in"
    | "between"
    | "is_null"
    | "is_not_null";

/**
 * A parenthesised set of conditions joined by one operator, so a filter can
 * express `a AND (b OR c)` rather than only a flat AND-chain. Groups nest.
 */
export interface FilterGroup {
    combinator: "and" | "or";
    conditions: FilterNode[];
}

export type FilterNode = QueryFilter | FilterGroup;

export function isFilterGroup(node: FilterNode): node is FilterGroup {
    return "combinator" in node;
}

/** Every condition in a tree, in order — for callers that can only honour a flat list (see the Redis driver). */
export function flattenFilters(nodes: FilterNode[]): QueryFilter[] {
    return nodes.flatMap((n) => (isFilterGroup(n) ? flattenFilters(n.conditions) : [n]));
}

const COMPARISON_OPS = new Set(["=", "!=", ">", ">=", "<", "<="]);

/** Neutralises wildcards inside text the user meant literally. Pairs with `ESCAPE '\'`. */
function escapeLike(value: unknown): string {
    return String(value ?? "").replace(/[\\%_]/g, "\\$&");
}

/** The same, for a Mongo regex — every character the engine would treat as syntax. */
function escapeRegex(value: unknown): string {
    return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FilterSqlOptions {
    /** Wraps an identifier in the dialect's quoting, e.g. double-quoted or backticked. */
    quote: (identifier: string) => string;
    /**
     * Renders one value as SQL text and records it. Drivers with a real
     * binder push onto their params array and return a placeholder; ClickHouse,
     * whose HTTP interface has no binder, returns an escaped literal instead.
     */
    bind: (value: unknown) => string;
    /** Dialects that spell LIKE differently (none so far) can override it. */
    like?: string;
    /**
     * ClickHouse's LIKE already treats backslash as the escape character and
     * rejects an ESCAPE clause, so it opts out; everything else needs the
     * clause for escaped wildcards to mean anything.
     */
    likeEscape?: boolean;
}

/**
 * Compiles a filter tree to a SQL boolean expression, or "" when there is
 * nothing to filter by. The top-level array is joined with AND.
 *
 * Shared rather than per-driver because this is the one place user input
 * becomes SQL text: column names are checked against the identifier charset,
 * operators against a closed set, and values only ever reach the query
 * through `bind`. Four copies of that logic had already drifted apart in
 * which operators each accepted.
 */
export function compileFilters(nodes: FilterNode[] | undefined, opts: FilterSqlOptions): string {
    if (!nodes?.length) return "";
    const parts = nodes.map((node) => compileNode(node, opts)).filter(Boolean);
    return parts.join(" AND ");
}

function compileNode(node: FilterNode, opts: FilterSqlOptions): string {
    if (isFilterGroup(node)) {
        if (node.combinator !== "and" && node.combinator !== "or") {
            throw new Error(`Invalid filter combinator: ${JSON.stringify(node.combinator)}`);
        }
        const inner = node.conditions.map((c) => compileNode(c, opts)).filter(Boolean);
        if (inner.length === 0) return "";
        // An OR group must keep its parentheses or it swallows the AND
        // chain around it; a single-child group doesn't need them.
        return inner.length === 1 ? inner[0] : `(${inner.join(` ${node.combinator.toUpperCase()} `)})`;
    }

    assertSafeIdentifier(node.column, "filter column");
    const col = opts.quote(node.column);
    const like = opts.like ?? "LIKE";

    const likeExpr = (pattern: string, negated: boolean) =>
        `${col} ${negated ? `NOT ${like}` : like} ${opts.bind(pattern)}${opts.likeEscape === false ? "" : " ESCAPE '\\'"}`;

    switch (node.op) {
        case "is_null":
            return `${col} IS NULL`;
        case "is_not_null":
            return `${col} IS NOT NULL`;
        case "like":
        case "not_like":
            // Raw pattern: the user is writing the wildcards, so no escaping
            // and no ESCAPE clause to change what their backslashes mean.
            return `${col} ${node.op === "not_like" ? `NOT ${like}` : like} ${opts.bind(node.value)}`;
        case "contains":
        case "not_contains":
            return likeExpr(`%${escapeLike(node.value)}%`, node.op === "not_contains");
        case "starts_with":
            return likeExpr(`${escapeLike(node.value)}%`, false);
        case "ends_with":
            return likeExpr(`%${escapeLike(node.value)}`, false);
        case "in":
        case "not_in": {
            const values = Array.isArray(node.value) ? node.value : [node.value];
            // IN () is a syntax error in every dialect here, and an empty set
            // matches nothing (NOT IN () matches everything) — say so directly.
            if (values.length === 0) return node.op === "in" ? "1 = 0" : "1 = 1";
            const list = values.map((v) => opts.bind(v)).join(", ");
            return `${col} ${node.op === "not_in" ? "NOT IN" : "IN"} (${list})`;
        }
        case "between": {
            const [low, high] = Array.isArray(node.value) ? node.value : [node.value, node.value];
            return `${col} BETWEEN ${opts.bind(low)} AND ${opts.bind(high)}`;
        }
        default:
            if (!COMPARISON_OPS.has(node.op)) throw new Error(`Invalid filter operator: ${JSON.stringify(node.op)}`);
            return `${col} ${node.op} ${opts.bind(node.value)}`;
    }
}

/** The same tree as a MongoDB query document. */
export function compileFilterMatch(nodes: FilterNode[] | undefined): Record<string, unknown> {
    if (!nodes?.length) return {};
    const parts = nodes.map(matchNode).filter((p) => Object.keys(p).length > 0);
    return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
}

function matchNode(node: FilterNode): Record<string, unknown> {
    if (isFilterGroup(node)) {
        const inner = node.conditions.map(matchNode).filter((p) => Object.keys(p).length > 0);
        if (inner.length === 0) return {};
        if (inner.length === 1) return inner[0];
        return { [node.combinator === "or" ? "$or" : "$and"]: inner };
    }

    assertSafeIdentifier(node.column, "filter column");
    switch (node.op) {
        case "is_null":
            return { [node.column]: null };
        case "is_not_null":
            return { [node.column]: { $ne: null } };
        case "like":
            return { [node.column]: { $regex: String(node.value ?? ""), $options: "i" } };
        case "not_like":
            return { [node.column]: { $not: new RegExp(String(node.value ?? ""), "i") } };
        case "contains":
            return { [node.column]: { $regex: escapeRegex(node.value), $options: "i" } };
        case "not_contains":
            return { [node.column]: { $not: new RegExp(escapeRegex(node.value), "i") } };
        case "starts_with":
            return { [node.column]: { $regex: `^${escapeRegex(node.value)}`, $options: "i" } };
        case "ends_with":
            return { [node.column]: { $regex: `${escapeRegex(node.value)}$`, $options: "i" } };
        case "in":
            return { [node.column]: { $in: Array.isArray(node.value) ? node.value : [node.value] } };
        case "not_in":
            return { [node.column]: { $nin: Array.isArray(node.value) ? node.value : [node.value] } };
        case "between": {
            const [low, high] = Array.isArray(node.value) ? node.value : [node.value, node.value];
            return { [node.column]: { $gte: low, $lte: high } };
        }
        default: {
            const mongoOp = { "=": "$eq", "!=": "$ne", ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte" }[node.op];
            if (!mongoOp) throw new Error(`Invalid filter operator: ${JSON.stringify(node.op)}`);
            return { [node.column]: { [mongoOp]: node.value } };
        }
    }
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
    /**
     * The ordering columns this page was sorted and keyed by, primary-key
     * tiebreaker included, in order. The UI needs these to know which column
     * a `seek` value applies to — it can't infer it, since the driver picks
     * the tiebreaker.
     */
    orderBy?: { column: string; direction: "asc" | "desc" }[];
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

const SQL_SAFE_LEADING_KEYWORDS = new Set([
    "select",
    "with",
    "explain",
    "show",
    "describe",
    "desc",
    "pragma",
    "values",
]);
// Whole-word scan for write/DDL verbs anywhere in the statement — catches a
// write smuggled inside a CTE (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`),
// which a leading-keyword check alone would miss.
const SQL_WRITE_VERB =
    /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|call|copy|vacuum|reindex|lock|replace|into\s+outfile)\b/i;

const REDIS_SAFE_READ_COMMANDS = new Set([
    "get",
    "mget",
    "strlen",
    "getrange",
    "exists",
    "type",
    "ttl",
    "pttl",
    "scan",
    "keys",
    "dbsize",
    "hget",
    "hmget",
    "hgetall",
    "hkeys",
    "hvals",
    "hlen",
    "hrandfield",
    "hexists",
    "hscan",
    "hstrlen",
    "lrange",
    "llen",
    "lindex",
    "lpos",
    "smembers",
    "scard",
    "sismember",
    "smismember",
    "srandmember",
    "sscan",
    "sinter",
    "sunion",
    "sdiff",
    "zrange",
    "zrangebyscore",
    "zrevrange",
    "zrevrangebyscore",
    "zscore",
    "zmscore",
    "zcard",
    "zcount",
    "zrank",
    "zrevrank",
    "zscan",
    "xrange",
    "xrevrange",
    "xlen",
    "xread",
    "ping",
    "echo",
    "info",
    "time",
    "config",
    "client",
    "object",
    "memory",
    "randomkey",
    "touch",
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
    insertRow(
        table: string,
        schema: string | undefined,
        values: Record<string, unknown>
    ): Promise<Record<string, unknown>>;

    /** Deletes the record(s) matching every column in primaryKey. */
    deleteRow(table: string, schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void>;

    /**
     * Optional: subscribe to native change notifications for a table (e.g.
     * MongoDB Change Streams, Postgres LISTEN/NOTIFY, Redis keyspace
     * notifications, or poll-and-diff where the database offers nothing).
     *
     * Implementations may need server-side setup to deliver this — the
     * Postgres driver installs a trigger, Redis needs notify-keyspace-events
     * — so an implementation MUST check BOTH `config.readOnly` and
     * `config.installCdc` and degrade to whatever it can do without writing,
     * rather than running DDL (or changing server-global settings) against a
     * database the user has not explicitly opted in.
     *
     * Returns an unsubscribe function. Callers must call it exactly once when
     * no longer interested — drivers that implement this should treat it as a
     * reference-counted resource internally if needed. Setup failures must
     * not reject asynchronously into the caller; degrade quietly instead.
     */
    watchTable?(table: string, schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void;

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

/**
 * Per-connection cache for schema metadata (column lists, primary keys).
 *
 * `queryRows` needs a table's columns and primary key on every call, but
 * those come from catalog queries that are far more expensive than the data
 * query itself — `information_schema` lookups in particular. Fetching them
 * per page turned one keyset page into four or five round-trips, which is
 * what made even a few hundred rows feel slow, and made a full export do
 * three catalog queries per 1000 rows.
 *
 * TTL'd rather than permanent so a DDL change is picked up without a
 * restart. Entries are keyed by whatever string the caller builds
 * (`schema.table`), and `clear()` drops everything on connection close.
 *
 * ponytail: single map, no size bound — a connection sees tens to thousands
 * of tables, not millions. Add an LRU cap if that ever stops being true.
 */
export class MetadataCache {
    private entries = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

    constructor(private ttlMs = 30_000) {}

    /**
     * Returns the cached value for `key`, or awaits and caches `load()`.
     *
     * The *promise* is cached, not the resolved value, so concurrent misses
     * for the same key share one round-trip instead of each firing their own
     * (a dashboard opening N widgets against one table, or a schema sweep
     * requested by several tables at once). A rejection is evicted so a
     * transient failure isn't cached for the whole TTL.
     */
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
        const hit = this.entries.get(key);
        if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;
        const value = load();
        const entry = { value: value as Promise<unknown>, expiresAt: Date.now() + this.ttlMs };
        this.entries.set(key, entry);
        value.catch(() => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
        });
        return value;
    }

    /** Seeds a key with an already-known value — used when one bulk query resolves many keys at once. */
    set<T>(key: string, value: T): void {
        this.entries.set(key, { value: Promise.resolve(value), expiresAt: Date.now() + this.ttlMs });
    }

    /** Drops one key (call after DDL this process performed), or use clear() for all. */
    invalidate(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}
