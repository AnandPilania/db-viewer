/// <reference path="./pg-cursor.d.ts" />
import pg from "pg";
import Cursor from "pg-cursor";
import type {
    ColumnDefinition,
    ColumnType,
    ConnectionConfig,
    DatabaseDriver,
    DriverConnection,
    QueryExecResult,
    QueryRowsOptions,
    QueryRowsResult,
    RowCountEstimate,
    RowCountExact,
    SchemaSummary,
    StreamQueryOptions,
    TableDefinition,
} from "@db-viewer/driver-interface";

const { Pool } = pg;

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
        const pkCols = await this.primaryKeyColumns(options.table, schema);
        const columns = await this.describeColumns(options.table, schema);
        const selectCols = options.columns?.length ? options.columns.map((c) => `"${c}"`).join(", ") : "*";

        const where: string[] = [];
        const params: unknown[] = [];
        let p = 1;

        if (options.afterCursor) {
            const cursorVals = decodeCursor(options.afterCursor);
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
        return raw < 0
            ? { value: 0, exact: false, source: "unsupported" }
            : { value: raw, exact: false, source: "statistics" };
    }

    async countRowsExact(table: string, schema = "public", signal?: AbortSignal): Promise<RowCountExact> {
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
        const client = await this.pool.connect();
        const chunkSize = options.chunkSize ?? 500;
        try {
            const cursor = client.query(new Cursor(options.sql, options.params ?? []));
            const onAbort = () => cursor.close(() => { });
            options.signal?.addEventListener("abort", onAbort, { once: true });
            try {
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

    async execute(sql: string, params: unknown[] = []): Promise<QueryExecResult> {
        const start = performance.now();
        const result = await this.pool.query(sql, params);
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

    async updateCell(
        table: string,
        schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        const s = schema ?? "public";
        const pkCols = Object.keys(primaryKey);
        const setClause = `"${column}" = $1`;
        const whereClause = pkCols.map((c, i) => `"${c}" = $${i + 2}`).join(" AND ");
        const sql = `UPDATE "${s}"."${table}" SET ${setClause} WHERE ${whereClause}`;
        await this.pool.query(sql, [value, ...pkCols.map((c) => primaryKey[c])]);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

export const postgresDriver: DatabaseDriver = {
    key: "postgres",
    displayName: "PostgreSQL",
    capabilities: { transactions: true, schemas: true, streaming: true, cancellation: true },

    async testConnection(config: ConnectionConfig) {
        const pool = new Pool({
            host: config.host,
            port: config.port ?? 5432,
            database: config.database,
            user: config.username,
            password: config.password,
            ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
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
            ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
            max: 10,
        });
        return new PostgresConnection(config.id, pool);
    },
};

export default postgresDriver;
