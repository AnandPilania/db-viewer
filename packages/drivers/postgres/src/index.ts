/// <reference path="./pg-cursor.d.ts" />
import pg from "pg";
import Cursor from "pg-cursor";
import {
    resolveSsl,
    assertSafeIdentifier,
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

// Only these ever reach the "else" branch below (is_null/is_not_null/in are
// handled separately) — anything else is a request body forged past the
// frontend's own TS types, since QueryFilter.op is a closed union there but
// req.body is untyped on arrival at the server.
const SAFE_COMPARISON_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "like"]);

/** node-postgres's ssl option accepts ca/cert/key directly as PEM strings — no temp files needed. */
function toPgSsl(config: ConnectionConfig): pg.PoolConfig["ssl"] {
    const ssl = resolveSsl(config.ssl);
    if (!ssl) return undefined;
    return { rejectUnauthorized: ssl.rejectUnauthorized ?? false, ca: ssl.ca, cert: ssl.cert, key: ssl.key };
}

function mapPgType(dataType: string): ColumnType {
    const t = dataType.toLowerCase();
    if (["int2", "int4", "int8", "numeric", "float4", "float8", "money", "smallint", "integer", "bigint", "real", "double precision", "decimal"].includes(t))
        return "number";
    if (["bool", "boolean"].includes(t)) return "boolean";
    if (["timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone"].includes(t)) return "datetime";
    if (t === "date") return "date";
    if (["json", "jsonb"].includes(t)) return "json";
    if (["bytea"].includes(t)) return "binary";
    if (["text", "varchar", "char", "bpchar", "character varying", "character", "uuid"].includes(t)) return "string";
    return "unknown";
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

    constructor(id: string, pool: pg.Pool) {
        this.id = id;
        this.pool = pool;
    }

    async listSchemas(): Promise<SchemaSummary[]> {
        const { rows } = await this.pool.query(
            `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema') ORDER BY schema_name`
        );
        const summaries: SchemaSummary[] = [];
        for (const r of rows) {
            const tables = await this.listTables(r.schema_name);
            summaries.push({ name: r.schema_name, tables: tables.map((t) => ({ schema: t.schema, name: t.name, kind: t.kind })) });
        }
        return summaries;
    }

    async listTables(schema = "public"): Promise<TableDefinition[]> {
        const { rows } = await this.pool.query(
            `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
       ORDER BY c.relname`,
            [schema]
        );
        const tables: TableDefinition[] = [];
        for (const r of rows) {
            const columns = await this.describeColumns(r.name, schema);
            tables.push({
                schema,
                name: r.name,
                kind: r.kind === "v" ? "view" : r.kind === "m" ? "materialized_view" : "table",
                columns,
                estimatedRowCount: Math.max(0, Number(r.estimate) || 0), // reltuples is -1 until the table is first ANALYZEd
            });
        }
        return tables;
    }

    private async describeColumns(table: string, schema: string): Promise<ColumnDefinition[]> {
        const { rows: cols } = await this.pool.query(
            `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
            [schema, table]
        );
        const { rows: pks } = await this.pool.query(
            `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = (quote_ident($1)||'.'||quote_ident($2))::regclass AND i.indisprimary`,
            [schema, table]
        );
        const { rows: fks } = await this.pool.query(
            `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
            [schema, table]
        );
        const pkSet = new Set(pks.map((p) => p.column_name));
        return cols.map((c) => {
            const fk = fks.find((f) => f.column_name === c.column_name);
            return {
                name: c.column_name,
                type: mapPgType(c.data_type),
                nativeType: c.data_type,
                nullable: c.is_nullable === "YES",
                isPrimaryKey: pkSet.has(c.column_name),
                isForeignKey: !!fk,
                references: fk ? { table: fk.foreign_table, column: fk.foreign_column } : undefined,
                defaultValue: c.column_default,
            };
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
        for (const f of options.filters ?? []) assertSafeIdentifier(f.column, "column");

        const pkCols = await this.primaryKeyColumns(options.table, schema);
        const columns = await this.describeColumns(options.table, schema);
        const selectCols = options.columns?.length ? options.columns.map((c) => `"${c}"`).join(", ") : "*";

        const where: string[] = [];
        const params: unknown[] = [];
        let p = 1;

        if (options.afterCursor) {
            const cursorVals = decodeCursor(options.afterCursor);
            // Row-wise comparison for correct multi-column keyset pagination: (pk1, pk2, ...) > (v1, v2, ...)
            const tuple = pkCols.map((c) => `"${c}"`).join(", ");
            const placeholders = cursorVals.map(() => `$${p++}`).join(", ");
            where.push(`(${tuple}) > (${placeholders})`);
            params.push(...cursorVals);
        }
        for (const f of options.filters ?? []) {
            if (f.op === "is_null") where.push(`"${f.column}" IS NULL`);
            else if (f.op === "is_not_null") where.push(`"${f.column}" IS NOT NULL`);
            else if (f.op === "in" && Array.isArray(f.value)) {
                const placeholders = f.value.map(() => `$${p++}`).join(", ");
                where.push(`"${f.column}" IN (${placeholders})`);
                params.push(...f.value);
            } else {
                if (!SAFE_COMPARISON_OPS.has(f.op)) throw new Error(`Invalid filter operator: ${JSON.stringify(f.op)}`);
                const opSql = f.op === "like" ? "LIKE" : f.op;
                where.push(`"${f.column}" ${opSql} $${p++}`);
                params.push(f.value);
            }
        }

        const orderBy = pkCols.map((c) => `"${c}" ASC`).join(", ");
        const sql = `SELECT ${selectCols} FROM "${schema}"."${options.table}" ${where.length ? "WHERE " + where.join(" AND ") : ""
            } ORDER BY ${orderBy} LIMIT $${p}`;
        params.push(options.pageSize + 1);

        const { rows } = await this.pool.query(sql, params);
        const hasMore = rows.length > options.pageSize;
        const page = hasMore ? rows.slice(0, options.pageSize) : rows;
        const nextCursor = hasMore ? encodeCursor(pkCols.map((c) => page[page.length - 1][c])) : null;

        return { rows: page, nextCursor, columns };
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
            const onAbort = () => cursor.close(() => { });
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
        const { rows } = await this.pool.query(sql, cols.map((c) => values[c]));
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
        await this.pool.query(`DELETE FROM "${s}"."${table}" WHERE ${whereClause}`, pkCols.map((c) => primaryKey[c]));
    }

    /**
     * Real CDC for Postgres: installs a trigger (idempotent — safe to call
     * repeatedly) that calls `pg_notify` on every row change, then LISTENs on
     * a single shared channel for the whole connection. This means external
     * writes (a row inserted directly in psql, by another application, etc.)
     * are picked up too, not just changes made through this app's own API.
     *
     * One dedicated LISTEN connection is shared across every table this
     * connection watches — Postgres requires a persistent connection for
     * LISTEN (it can't come from the query pool), so we only want one, not
     * one per table.
     */
    watchTable(table: string, schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void {
        const s = schema ?? "public";
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(s, "schema");
        const key = `${s}.${table}`;

        if (!this.watchHandlers.has(key)) this.watchHandlers.set(key, new Set());
        this.watchHandlers.get(key)!.add(onChange);

        // Fire-and-forget async setup — the interface requires a synchronous
        // return, but installing the trigger and opening the LISTEN connection
        // are both async. Notifications simply won't arrive until this
        // resolves (a few hundred ms on first watch of a given connection).
        void this.ensureListening(s, table);

        return () => {
            this.watchHandlers.get(key)?.delete(onChange);
        };
    }

    private async ensureListening(schema: string, table: string): Promise<void> {
        const triggerKey = `${schema}.${table}`;
        if (!this.triggersInstalled.has(triggerKey)) {
            this.triggersInstalled.add(triggerKey);
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
        }

        if (!this.listenerSetupPromise) {
            this.listenerSetupPromise = (async () => {
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
        await this.listenerSetupPromise;
    }

    async close(): Promise<void> {
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
        return new PostgresConnection(config.id, pool);
    },
};

export default postgresDriver;
