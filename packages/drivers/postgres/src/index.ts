import pg from "pg";
import Cursor from "pg-cursor";
import {
    resolveSsl,
    assertSafeIdentifier,
    compileFilters,
    diffTableSnapshots,
    keysetComparison,
    MetadataCache,
    resolveOrderBy,
    type ColumnDefinition,
    type ColumnType,
    type ConnectionConfig,
    type DatabaseDriver,
    type DriverConnection,
    type ExecSpec,
    type QueryExecResult,
    type QueryRowsOptions,
    type QueryRowsResult,
    type RowChangeEvent,
    type RowCountEstimate,
    type RowCountExact,
    type SchemaSummary,
    type StreamQueryOptions,
    type TableDefinition,
} from "@pilaniaanand/driver-interface";

const { Pool } = pg;

// Only used by the no-DDL fallback watcher (see watchTable).
const POLL_INTERVAL_MS = 1000;
const WATCH_ROW_LIMIT = 1000;

// Only these ever reach the "else" branch below (is_null/is_not_null/in are
// handled separately) — anything else is a request body forged past the
// frontend's own TS types, since QueryFilter.op is a closed union there but
// req.body is untyped on arrival at the server.

/** node-postgres's ssl option accepts ca/cert/key directly as PEM strings — no temp files needed. */
function toPgSsl(config: ConnectionConfig): pg.PoolConfig["ssl"] {
    const ssl = resolveSsl(config.ssl);
    if (!ssl) return undefined;
    return { rejectUnauthorized: ssl.rejectUnauthorized ?? false, ca: ssl.ca, cert: ssl.cert, key: ssl.key };
}

function mapPgType(dataType: string): ColumnType {
    // format_type() returns modifiers and array markers — "character
    // varying(255)", "numeric(10,2)", "text[]" — none of which change the
    // logical bucket, so strip them before matching.
    const t = dataType.toLowerCase().replace(/\(.*$/, "").replace(/\[\]$/, "").trim();
    if (
        [
            "int2",
            "int4",
            "int8",
            "numeric",
            "float4",
            "float8",
            "money",
            "smallint",
            "integer",
            "bigint",
            "real",
            "double precision",
            "decimal",
        ].includes(t)
    )
        return "number";
    if (["bool", "boolean"].includes(t)) return "boolean";
    if (["timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone"].includes(t))
        return "datetime";
    if (t === "date") return "date";
    if (["json", "jsonb"].includes(t)) return "json";
    if (["bytea"].includes(t)) return "binary";
    if (["text", "varchar", "char", "bpchar", "character varying", "character", "uuid"].includes(t)) return "string";
    return "unknown";
}

/** Extracts the declared length out of a formatted type like "character varying(255)". */
function extractMaxLength(dataType: string): number | undefined {
    const match = dataType.match(/^(?:character varying|character|varchar|char|bpchar)\((\d+)\)/i);
    return match ? Number(match[1]) : undefined;
}

function encodeCursor(values: unknown[]): string {
    return Buffer.from(JSON.stringify(values)).toString("base64");
}
function decodeCursor(cursor: string): unknown[] {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
}

class PostgresConnection implements DriverConnection {
    readonly id: string;
    private pool: pg.Pool;
    private listenerClient: pg.PoolClient | null = null;
    private listenerSetupPromise: Promise<void> | null = null;
    private watchHandlers = new Map<string, Set<(event: RowChangeEvent) => void>>();
    private triggersInstalled = new Set<string>();
    private watchIntervals = new Map<string, ReturnType<typeof setInterval>>();
    private metadata = new MetadataCache();

    /**
     * True when this connection was saved read-only. Live table watching on
     * Postgres is trigger-based, i.e. DDL — the route-level read-only gate
     * only covers insert/update/delete/execute, so without this a connection
     * the user marked read-only would still have CREATE TRIGGER run against
     * it the moment they opened a table.
     */
    private readOnly: boolean;

    /**
     * Whether the user explicitly opted this connection in to trigger-based
     * CDC. Off by default: installing a trigger into someone else's database
     * is a schema change they did not ask for and cannot see from this app.
     */
    private installCdc: boolean;

    constructor(id: string, pool: pg.Pool, readOnly = false, installCdc = false) {
        this.id = id;
        this.pool = pool;
        this.readOnly = readOnly;
        // A read-only connection never writes DDL, whatever the CDC flag says.
        this.installCdc = installCdc && !readOnly;
    }

    async listSchemas(): Promise<SchemaSummary[]> {
        const { rows } = await this.pool.query(
            `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema') ORDER BY schema_name`
        );
        // In parallel: the per-schema sweeps are independent, and doing them in
        // sequence made the sidebar's first paint the sum of every schema's
        // catalog query rather than the slowest one.
        return Promise.all(
            rows.map(async (r) => {
                const tables = await this.listTables(r.schema_name);
                return {
                    name: r.schema_name,
                    tables: tables.map((t) => ({ schema: t.schema, name: t.name, kind: t.kind })),
                };
            })
        );
    }

    async listTables(schema = "public"): Promise<TableDefinition[]> {
        const [{ rows }, columnsByTable] = await Promise.all([
            this.pool.query(
                `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
       ORDER BY c.relname`,
                [schema]
            ),
            this.schemaColumns(schema),
        ]);
        return rows.map((r) => ({
            schema,
            name: r.name,
            kind: r.kind === "v" ? "view" : r.kind === "m" ? "materialized_view" : "table",
            columns: columnsByTable.get(r.name) ?? [],
            estimatedRowCount: Math.max(0, Number(r.estimate) || 0), // reltuples is -1 until the table is first ANALYZEd
        }));
    }

    /**
     * Every column, primary key, and foreign key in a schema in three
     * catalog queries, grouped by table.
     *
     * This used to be three queries *per table*, which made drawing the
     * schema sidebar cost 3N round-trips — minutes on a database with a few
     * thousand tables. Each table's entry is also seeded into the metadata
     * cache on the way out, so the subsequent per-table describeColumns()
     * calls (from queryRows, describeTable) are all cache hits.
     *
     * pg_catalog is queried directly rather than information_schema: the
     * latter is a set of permission-filtering views that plan poorly and are
     * dramatically slower on large catalogs.
     */
    private schemaColumns(schema: string): Promise<Map<string, ColumnDefinition[]>> {
        return this.metadata.get(`schema-cols:${schema}`, async () => {
            const [{ rows: cols }, { rows: pks }, { rows: fks }, { rows: checks }, { rows: uniques }, { rows: enums }] =
                await Promise.all([
                    this.pool.query(
                        `SELECT c.relname AS table_name,
                    a.attname AS column_name,
                    format_type(a.atttypid, a.atttypmod) AS data_type,
                    NOT a.attnotnull AS nullable,
                    pg_get_expr(d.adbin, d.adrelid) AS column_default
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY c.relname, a.attnum`,
                        [schema]
                    ),
                    this.pool.query(
                        `SELECT c.relname AS table_name, a.attname AS column_name
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE n.nspname = $1 AND i.indisprimary`,
                        [schema]
                    ),
                    this.pool.query(
                        `SELECT c.relname AS table_name,
                    a.attname AS column_name,
                    fc.relname AS foreign_table,
                    fa.attname AS foreign_column
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_class fc ON fc.oid = con.confrelid
             JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
             JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
             JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = fk.attnum
             WHERE n.nspname = $1 AND con.contype = 'f'`,
                        [schema]
                    ),
                    // CHECK constraints: a constraint can reference several columns, so it's
                    // attached (display-only, never evaluated) to every column it names.
                    this.pool.query(
                        `SELECT c.relname AS table_name, a.attname AS column_name,
                    pg_get_constraintdef(con.oid) AS definition
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN unnest(con.conkey) AS ck(colnum) ON TRUE
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ck.colnum
             WHERE n.nspname = $1 AND con.contype = 'c'`,
                        [schema]
                    ),
                    // UNIQUE constraints: only single-column ones translate to a per-column
                    // boolean — a multi-column unique constraint doesn't make any one column
                    // unique on its own.
                    this.pool.query(
                        `SELECT c.relname AS table_name, a.attname AS column_name
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
             WHERE n.nspname = $1 AND con.contype = 'u' AND array_length(con.conkey, 1) = 1`,
                        [schema]
                    ),
                    // Enum labels for columns whose type is a user-defined enum.
                    this.pool.query(
                        `SELECT c.relname AS table_name, a.attname AS column_name, e.enumlabel
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_type t ON t.oid = a.atttypid
             JOIN pg_enum e ON e.enumtypid = t.oid
             WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY c.relname, a.attname, e.enumsortorder`,
                        [schema]
                    ),
                ]);

            const pkSet = new Set(pks.map((p) => `${p.table_name}.${p.column_name}`));
            const fkMap = new Map(fks.map((f) => [`${f.table_name}.${f.column_name}`, f]));
            const checkMap = new Map<string, string>();
            for (const chk of checks) {
                const key = `${chk.table_name}.${chk.column_name}`;
                // A column can be named by more than one CHECK; keep the first and
                // move on — this is display-only text, not something enforced here.
                if (!checkMap.has(key)) checkMap.set(key, chk.definition);
            }
            const uniqueSet = new Set(uniques.map((u) => `${u.table_name}.${u.column_name}`));
            const enumMap = new Map<string, string[]>();
            for (const e of enums) {
                const key = `${e.table_name}.${e.column_name}`;
                const list = enumMap.get(key) ?? [];
                list.push(e.enumlabel);
                enumMap.set(key, list);
            }

            const byTable = new Map<string, ColumnDefinition[]>();
            for (const c of cols) {
                const key = `${c.table_name}.${c.column_name}`;
                const fk = fkMap.get(key);
                const list = byTable.get(c.table_name) ?? [];
                list.push({
                    name: c.column_name,
                    type: mapPgType(c.data_type),
                    nativeType: c.data_type,
                    nullable: c.nullable,
                    isPrimaryKey: pkSet.has(key),
                    isForeignKey: !!fk,
                    references: fk ? { table: fk.foreign_table, column: fk.foreign_column } : undefined,
                    defaultValue: c.column_default,
                    maxLength: extractMaxLength(c.data_type),
                    enumValues: enumMap.get(key),
                    isUnique: uniqueSet.has(key) || undefined,
                    checkExpression: checkMap.get(key),
                });
                byTable.set(c.table_name, list);
            }

            for (const [table, columns] of byTable) this.metadata.set(`cols:${schema}.${table}`, columns);
            return byTable;
        });
    }

    /** One table's columns. Resolved from the schema-wide sweep above, so N tables cost 3 queries, not 3N. */
    private describeColumns(table: string, schema: string): Promise<ColumnDefinition[]> {
        return this.metadata.get(`cols:${schema}.${table}`, async () => {
            const byTable = await this.schemaColumns(schema);
            return byTable.get(table) ?? [];
        });
    }

    async describeTable(table: string, schema = "public"): Promise<TableDefinition> {
        return { schema, name: table, kind: "table", columns: await this.describeColumns(table, schema) };
    }

    private async primaryKeyColumns(table: string, schema: string): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = (quote_ident($1)||'.'||quote_ident($2))::regclass AND i.indisprimary
       ORDER BY a.attnum`,
            [schema, table]
        );
        return rows.length ? rows.map((r) => r.column_name) : ["ctid"]; // fallback: physical row id
    }

    async queryRows(options: QueryRowsOptions): Promise<QueryRowsResult> {
        const schema = options.schema ?? "public";
        assertSafeIdentifier(options.table, "table");
        assertSafeIdentifier(schema, "schema");
        for (const c of options.columns ?? []) assertSafeIdentifier(c, "column");
        for (const s of options.sort ?? []) assertSafeIdentifier(s.column, "sort column");

        // Cached: these are catalog queries, and re-running them for every
        // keyset page is what dominated the cost of paging a table.
        const [pkCols, columns] = await Promise.all([
            this.metadata.get(`pk:${schema}.${options.table}`, () => this.primaryKeyColumns(options.table, schema)),
            this.describeColumns(options.table, schema),
        ]);
        const selectCols = options.columns?.length ? options.columns.map((c) => `"${c}"`).join(", ") : "*";

        const orderBy = resolveOrderBy(options.sort, pkCols);
        const descending = orderBy[0].direction === "desc";
        const orderCols = orderBy.map((o) => o.column);

        const where: string[] = [];
        const params: unknown[] = [];
        let p = 1;

        const quote = (identifier: string) => `"${identifier}"`;
        const keysetPredicate = (values: unknown[], inclusive: boolean) => {
            const base = p;
            where.push(
                keysetComparison(orderCols, values.length, {
                    descending,
                    inclusive,
                    quote,
                    placeholder: (i) => `$${base + i}`,
                })
            );
            p += values.length;
            params.push(...values);
        };

        if (options.afterCursor) {
            keysetPredicate(decodeCursor(options.afterCursor), false);
        } else if (options.seek?.length) {
            keysetPredicate(options.seek.slice(0, orderCols.length), true);
        }

        // Columns, operators and combinators are validated inside the shared
        // compiler; values only ever arrive as bound parameters.
        const filterSql = compileFilters(options.filters, {
            quote,
            bind: (value) => {
                params.push(value);
                return `$${p++}`;
            },
        });
        if (filterSql) where.push(filterSql);

        const orderSql = orderBy.map((o) => `${quote(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`).join(", ");
        const sql = `SELECT ${selectCols} FROM "${schema}"."${options.table}" ${
            where.length ? "WHERE " + where.join(" AND ") : ""
        } ORDER BY ${orderSql} LIMIT $${p}`;
        params.push(options.pageSize + 1);

        const { rows } = await this.pool.query({ text: sql, values: params });
        const hasMore = rows.length > options.pageSize;
        const page = hasMore ? rows.slice(0, options.pageSize) : rows;
        const nextCursor = hasMore ? encodeCursor(orderCols.map((c) => page[page.length - 1][c])) : null;

        return { rows: page, nextCursor, columns, orderBy };
    }

    async estimateRowCount(table: string, schema = "public"): Promise<RowCountEstimate> {
        const { rows } = await this.pool.query(
            `SELECT reltuples::bigint AS estimate FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
            [schema, table]
        );
        const raw = Number(rows[0]?.estimate ?? 0);
        // Postgres sets reltuples = -1 until the table's first ANALYZE; there's no
        // real statistic yet, so say so rather than showing a negative count.
        return raw < 0
            ? { value: 0, exact: false, source: "unsupported" }
            : { value: raw, exact: false, source: "statistics" };
    }

    async countRowsExact(table: string, schema = "public", signal?: AbortSignal): Promise<RowCountExact> {
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(schema, "schema");
        const client = await this.pool.connect();
        try {
            const pidRes = await client.query("SELECT pg_backend_pid() AS pid");
            const pid = pidRes.rows[0].pid;
            const onAbort = async () => {
                try {
                    await this.pool.query("SELECT pg_cancel_backend($1)", [pid]);
                } catch {
                    /* ignore */
                }
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                const { rows } = await client.query(`SELECT COUNT(*) AS c FROM "${schema}"."${table}"`);
                return { value: Number(rows[0].c), exact: true };
            } finally {
                signal?.removeEventListener("abort", onAbort);
            }
        } finally {
            client.release();
        }
    }

    async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
        if (options.query.language !== "sql") {
            throw new Error(`PostgreSQL only supports SQL queries, got "${options.query.language}"`);
        }
        const { sql, params = [] } = options.query;
        const client = await this.pool.connect();
        const chunkSize = options.chunkSize ?? 500;
        try {
            const cursor = client.query(new Cursor(sql, params));
            const onAbort = () => cursor.close(() => {});
            options.signal?.addEventListener("abort", onAbort, { once: true });
            try {
                // pg-cursor doesn't expose column metadata cleanly until first read; leave empty and let caller infer from row keys.
                while (true) {
                    if (options.signal?.aborted) break;
                    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) =>
                        cursor.read(chunkSize, (err: Error, rows: unknown[]) =>
                            err ? reject(err) : resolve(rows as Record<string, unknown>[])
                        )
                    );
                    if (rows.length === 0) break;
                    yield { rows, nextCursor: null, columns: [] };
                    if (rows.length < chunkSize) break;
                }
            } finally {
                options.signal?.removeEventListener("abort", onAbort);
                await new Promise<void>((resolve) => cursor.close(() => resolve()));
            }
        } finally {
            client.release();
        }
    }

    async execute(query: ExecSpec): Promise<QueryExecResult> {
        if (query.language !== "sql") {
            throw new Error(`PostgreSQL only supports SQL queries, got "${query.language}"`);
        }
        const start = performance.now();
        const result = await this.pool.query(query.sql, query.params ?? []);
        const columns: ColumnDefinition[] = (result.fields ?? []).map((f) => ({
            name: f.name,
            type: "unknown",
            nativeType: String(f.dataTypeID),
            nullable: true,
            isPrimaryKey: false,
            isForeignKey: false,
        }));
        return { columns, affectedRows: result.rowCount ?? undefined, durationMs: performance.now() - start };
    }

    async insertRow(
        table: string,
        schema: string | undefined,
        values: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
        const s = schema ?? "public";
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(s, "schema");
        const cols = Object.keys(values);
        for (const c of cols) assertSafeIdentifier(c, "column");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const sql = cols.length
            ? `INSERT INTO "${s}"."${table}" (${colList}) VALUES (${placeholders}) RETURNING *`
            : `INSERT INTO "${s}"."${table}" DEFAULT VALUES RETURNING *`;
        const { rows } = await this.pool.query(
            sql,
            cols.map((c) => values[c])
        );
        return rows[0];
    }

    async updateCell(
        table: string,
        schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        const s = schema ?? "public";
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(s, "schema");
        assertSafeIdentifier(column, "column");
        const pkCols = Object.keys(primaryKey);
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const setClause = `"${column}" = $1`;
        const whereClause = pkCols.map((c, i) => `"${c}" = $${i + 2}`).join(" AND ");
        const sql = `UPDATE "${s}"."${table}" SET ${setClause} WHERE ${whereClause}`;
        await this.pool.query(sql, [value, ...pkCols.map((c) => primaryKey[c])]);
    }

    async deleteRow(table: string, schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void> {
        const s = schema ?? "public";
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(s, "schema");
        const pkCols = Object.keys(primaryKey);
        if (pkCols.length === 0) throw new Error("deleteRow requires at least one primary key column");
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const whereClause = pkCols.map((c, i) => `"${c}" = $${i + 1}`).join(" AND ");
        await this.pool.query(
            `DELETE FROM "${s}"."${table}" WHERE ${whereClause}`,
            pkCols.map((c) => primaryKey[c])
        );
    }

    /**
     * Trigger-based CDC for Postgres, but ONLY when the connection opted in
     * via `installCdc`. That path installs a trigger (idempotent — safe to
     * call repeatedly) that calls `pg_notify` on every row change, then
     * LISTENs on a single shared channel for the whole connection, so
     * external writes (a row inserted directly in psql, by another
     * application) are picked up too.
     *
     * One dedicated LISTEN connection is shared across every table this
     * connection watches — Postgres requires a persistent connection for
     * LISTEN (it can't come from the query pool), so we only want one, not
     * one per table.
     *
     * Without that opt-in — the default — we do NOT touch the user's schema,
     * and fall back to the same read-only poll-and-diff MySQL uses. Slower to
     * notice a change and capped at WATCH_ROW_LIMIT rows, but it leaves no
     * trace in a database this app does not own.
     */
    watchTable(table: string, schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void {
        const s = schema ?? "public";
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(s, "schema");
        const key = `${s}.${table}`;

        if (!this.installCdc) return this.watchByPolling(s, table, onChange);

        if (!this.watchHandlers.has(key)) this.watchHandlers.set(key, new Set());
        this.watchHandlers.get(key)!.add(onChange);

        // Fire-and-forget async setup — the interface requires a synchronous
        // return, but installing the trigger and opening the LISTEN connection
        // are both async. Notifications simply won't arrive until this
        // resolves (a few hundred ms on first watch of a given connection).
        // Swallowed rather than left to reject: a database that refuses the
        // trigger (no permission, read replica) should cost the user live
        // updates, not an unhandled rejection that takes down the process.
        this.ensureListening(s, table).catch(() => {
            /* live updates unavailable for this table; app-originated events still flow */
        });

        return () => {
            this.watchHandlers.get(key)?.delete(onChange);
        };
    }

    /**
     * ponytail: poll-and-diff, the same approach the MySQL driver uses — no
     * writes of any kind to the target database. Ceiling: it only sees the
     * first WATCH_ROW_LIMIT rows and notices a change up to POLL_INTERVAL_MS
     * late. Set `installCdc` on the connection for true CDC once a DBA has
     * signed off on the trigger.
     */
    private watchByPolling(schema: string, table: string, onChange: (event: RowChangeEvent) => void): () => void {
        const key = `${schema}.${table}`;
        let lastRows: Record<string, unknown>[] | null = null;
        let stopped = false;

        const poll = async () => {
            const pkCols = await this.metadata.get(`pk:${key}`, () => this.primaryKeyColumns(table, schema));
            const { rows } = await this.pool.query(`SELECT * FROM "${schema}"."${table}" LIMIT ${WATCH_ROW_LIMIT}`);
            if (stopped) return;
            // The first poll only establishes a baseline — diffing against
            // nothing would replay the whole table as inserts.
            if (lastRows) for (const event of diffTableSnapshots(lastRows, rows, pkCols)) onChange(event);
            lastRows = rows;
        };

        const onPollError = (err: unknown) =>
            console.error(`Postgres table-watch poll failed for "${key}":`, (err as Error).message);
        void poll().catch(onPollError);
        const interval = setInterval(() => void poll().catch(onPollError), POLL_INTERVAL_MS);
        this.watchIntervals.set(key, interval);

        return () => {
            stopped = true;
            clearInterval(interval);
            this.watchIntervals.delete(key);
        };
    }

    private async ensureListening(schema: string, table: string): Promise<void> {
        const triggerKey = `${schema}.${table}`;
        // Only reachable with installCdc set (which already excludes
        // read-only connections) — watchTable routes everything else to the
        // no-DDL poller before it gets here.
        if (!this.triggersInstalled.has(triggerKey)) {
            await this.pool.query(`
        CREATE OR REPLACE FUNCTION __dbviewer_notify_change() RETURNS TRIGGER AS $$
        DECLARE
          row_json JSON;
          payload TEXT;
        BEGIN
          -- This trigger exists purely to power an optional live-updates
          -- feature in db-viewer — it must never be able to abort or
          -- otherwise interfere with the write that fired it, no matter
          -- what goes wrong in here (a payload too large for pg_notify's
          -- hard ~8000-byte limit — a real production incident this
          -- exact function caused before this guard existed — or any
          -- other unexpected error).
          BEGIN
            IF TG_OP = 'DELETE' THEN
              row_json := row_to_json(OLD);
            ELSE
              row_json := row_to_json(NEW);
            END IF;

            payload := json_build_object(
              'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'op', TG_OP, 'row', row_json
            )::text;

            -- A wide row (large text/jsonb/encrypted-blob columns) can push
            -- the full-row payload past pg_notify's limit. Rather than risk
            -- that, drop the row data above a safe threshold and send just
            -- the identifying fields — db-viewer falls back to treating it
            -- as a plain "something changed" signal for that one event
            -- instead of patching in place.
            IF octet_length(payload) > 7500 THEN
              payload := json_build_object('schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'op', TG_OP)::text;
            END IF;

            PERFORM pg_notify('dbviewer_changes', payload);
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
      `);
            await this.pool.query(`DROP TRIGGER IF EXISTS __dbviewer_watch ON "${schema}"."${table}"`);
            await this.pool.query(`
        CREATE TRIGGER __dbviewer_watch
        AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."${table}"
        FOR EACH ROW EXECUTE FUNCTION __dbviewer_notify_change();
      `);
            // Recorded only after the DDL actually succeeded — marking it up
            // front meant one transient failure disabled live updates for that
            // table until restart, and left close() trying to drop a trigger
            // that was never created.
            this.triggersInstalled.add(triggerKey);
        }

        if (!this.listenerSetupPromise) {
            this.listenerSetupPromise = (async () => {
                // Cleared on failure so a later watch retries rather than
                // awaiting a promise that will never resolve.
                const client = await this.pool.connect();
                this.listenerClient = client;
                await client.query("LISTEN dbviewer_changes");
                client.on("notification", (msg) => {
                    if (!msg.payload) return;
                    let parsed: { schema: string; table: string; op: string; row?: Record<string, unknown> };
                    try {
                        parsed = JSON.parse(msg.payload);
                    } catch {
                        return;
                    }
                    const handlers = this.watchHandlers.get(`${parsed.schema}.${parsed.table}`);
                    if (!handlers || handlers.size === 0) return;
                    const event: RowChangeEvent =
                        parsed.op === "INSERT"
                            ? { type: "insert", row: parsed.row }
                            : parsed.op === "DELETE"
                              ? { type: "delete", primaryKey: parsed.row }
                              : { type: "update", primaryKey: parsed.row, column: "__row__", value: parsed.row };
                    for (const handler of handlers) handler(event);
                });
            })();
        }
        try {
            await this.listenerSetupPromise;
        } catch (err) {
            this.listenerSetupPromise = null;
            throw err;
        }
    }

    async close(): Promise<void> {
        this.metadata.clear();
        for (const interval of this.watchIntervals.values()) clearInterval(interval);
        this.watchIntervals.clear();
        for (const key of this.triggersInstalled) {
            const [schema, table] = key.split(".");
            await this.pool.query(`DROP TRIGGER IF EXISTS __dbviewer_watch ON "${schema}"."${table}"`).catch(() => {});
        }
        if (this.triggersInstalled.size > 0) {
            await this.pool.query(`DROP FUNCTION IF EXISTS __dbviewer_notify_change()`).catch(() => {});
        }
        if (this.listenerClient) this.listenerClient.release();
        await this.pool.end();
    }
}

export const postgresDriver: DatabaseDriver = {
    key: "postgres",
    displayName: "PostgreSQL",
    capabilities: { transactions: true, schemas: true, streaming: true, cancellation: true, queryLanguage: "sql" },

    async testConnection(config: ConnectionConfig) {
        const pool = new Pool({
            host: config.host,
            port: config.port ?? 5432,
            database: config.database,
            user: config.username,
            password: config.password,
            ssl: toPgSsl(config),
            max: 1,
            connectionTimeoutMillis: 5000,
        });
        try {
            await pool.query("SELECT 1");
            return { ok: true };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        } finally {
            await pool.end();
        }
    },

    async connect(config: ConnectionConfig): Promise<DriverConnection> {
        const pool = new Pool({
            host: config.host,
            port: config.port ?? 5432,
            database: config.database,
            user: config.username,
            password: config.password,
            ssl: toPgSsl(config),
            max: 10,
        });
        return new PostgresConnection(
            config.id,
            pool,
            !!config.readOnly || process.env.DB_VIEWER_READ_ONLY === "true",
            !!config.installCdc
        );
    },
};

export default postgresDriver;
