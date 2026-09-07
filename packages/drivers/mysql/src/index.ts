import mysql from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import {
    diffTableSnapshots,
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

// MySQL has no low-effort push mechanism (that's binlog replication, real
// infrastructure) — poll-and-diff instead. Row-store writes are visible to
// every connection immediately, unlike ClickHouse's async mutations.
const POLL_INTERVAL_MS = 1000;
const WATCH_ROW_LIMIT = 1000;

// Only these ever reach the "else" branch in queryRows below (is_null/
// is_not_null/in are handled separately) — anything else is a request body
// forged past the frontend's own TS types, since QueryFilter.op is a closed
// union there but req.body is untyped on arrival at the server.
const SAFE_COMPARISON_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "like"]);

/** mysql2's ssl option accepts ca/cert/key directly as PEM strings — no temp files needed. */
function toMysqlSsl(config: ConnectionConfig): mysql.PoolOptions["ssl"] {
    const ssl = resolveSsl(config.ssl);
    if (!ssl) return undefined;
    return { rejectUnauthorized: ssl.rejectUnauthorized ?? true, ca: ssl.ca, cert: ssl.cert, key: ssl.key };
}

function mapMysqlType(dataType: string): ColumnType {
    const t = dataType.toLowerCase();
    if (["tinyint", "smallint", "mediumint", "int", "bigint", "decimal", "float", "double", "year"].includes(t))
        return "number";
    if (t === "tinyint(1)" || t === "bool" || t === "boolean") return "boolean";
    if (["datetime", "timestamp"].includes(t)) return "datetime";
    if (t === "date") return "date";
    if (["json"].includes(t)) return "json";
    if (["blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary"].includes(t)) return "binary";
    if (["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "enum", "set"].includes(t)) return "string";
    return "unknown";
}

function encodeCursor(values: unknown[]): string {
    return Buffer.from(JSON.stringify(values)).toString("base64");
}
function decodeCursor(cursor: string): unknown[] {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
}

class MysqlConnection implements DriverConnection {
    readonly id: string;
    private pool: Pool;
    private database: string;
    private watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

    constructor(id: string, pool: Pool, database: string) {
        this.id = id;
        this.pool = pool;
        this.database = database;
    }

    // MySQL has no schema concept above database/table in the Postgres sense —
    // we treat the connected database itself as the single "schema".
    async listSchemas(): Promise<SchemaSummary[]> {
        const tables = await this.listTables();
        return [{ name: this.database, tables: tables.map((t) => ({ name: t.name, kind: t.kind })) }];
    }

    async listTables(): Promise<TableDefinition[]> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimate
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
            [this.database]
        );
        const tables: TableDefinition[] = [];
        for (const r of rows) {
            tables.push({
                name: r.name,
                kind: r.type === "VIEW" ? "view" : "table",
                columns: await this.describeColumns(r.name),
                estimatedRowCount: Number(r.estimate) || 0,
            });
        }
        return tables;
    }

    private async describeColumns(table: string): Promise<ColumnDefinition[]> {
        const [cols] = await this.pool.query<RowDataPacket[]>(
            `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable,
              COLUMN_KEY AS colKey, COLUMN_DEFAULT AS defaultValue
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
            [this.database, table]
        );
        const [fks] = await this.pool.query<RowDataPacket[]>(
            `SELECT COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
            [this.database, table]
        );
        return cols.map((c) => {
            const fk = fks.find((f) => f.col === c.name);
            return {
                name: c.name,
                type: mapMysqlType(c.dataType),
                nativeType: c.dataType,
                nullable: c.nullable === "YES",
                isPrimaryKey: c.colKey === "PRI",
                isForeignKey: !!fk,
                references: fk ? { table: fk.refTable, column: fk.refCol } : undefined,
                defaultValue: c.defaultValue,
            };
        });
    }

    async describeTable(table: string): Promise<TableDefinition> {
        return { name: table, kind: "table", columns: await this.describeColumns(table) };
    }

    private async primaryKeyColumns(table: string): Promise<string[]> {
        const cols = await this.describeColumns(table);
        const pks = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
        return pks.length ? pks : [cols[0]?.name].filter(Boolean); // fallback: first column
    }

    async queryRows(options: QueryRowsOptions): Promise<QueryRowsResult> {
        assertSafeIdentifier(options.table, "table");
        for (const c of options.columns ?? []) assertSafeIdentifier(c, "column");
        for (const f of options.filters ?? []) assertSafeIdentifier(f.column, "column");

        const pkCols = await this.primaryKeyColumns(options.table);
        const columns = await this.describeColumns(options.table);
        const selectCols = options.columns?.length ? options.columns.map((c) => `\`${c}\``).join(", ") : "*";

        const where: string[] = [];
        const params: unknown[] = [];

        if (options.afterCursor) {
            const cursorVals = decodeCursor(options.afterCursor);
            const tuple = pkCols.map((c) => `\`${c}\``).join(", ");
            const placeholders = cursorVals.map(() => "?").join(", ");
            where.push(`(${tuple}) > (${placeholders})`);
            params.push(...cursorVals);
        }
        for (const f of options.filters ?? []) {
            if (f.op === "is_null") where.push(`\`${f.column}\` IS NULL`);
            else if (f.op === "is_not_null") where.push(`\`${f.column}\` IS NOT NULL`);
            else if (f.op === "in" && Array.isArray(f.value)) {
                where.push(`\`${f.column}\` IN (${f.value.map(() => "?").join(", ")})`);
                params.push(...f.value);
            } else {
                if (!SAFE_COMPARISON_OPS.has(f.op)) throw new Error(`Invalid filter operator: ${JSON.stringify(f.op)}`);
                const opSql = f.op === "like" ? "LIKE" : f.op;
                where.push(`\`${f.column}\` ${opSql} ?`);
                params.push(f.value);
            }
        }

        const orderBy = pkCols.map((c) => `\`${c}\` ASC`).join(", ");
        const sql = `SELECT ${selectCols} FROM \`${options.table}\` ${where.length ? "WHERE " + where.join(" AND ") : ""
            } ORDER BY ${orderBy} LIMIT ?`;
        params.push(options.pageSize + 1);

        const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
        const hasMore = rows.length > options.pageSize;
        const page = hasMore ? rows.slice(0, options.pageSize) : rows;
        const nextCursor = hasMore ? encodeCursor(pkCols.map((c) => page[page.length - 1][c])) : null;

        return { rows: page as Record<string, unknown>[], nextCursor, columns };
    }

    async estimateRowCount(table: string): Promise<RowCountEstimate> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
            [this.database, table]
        );
        return { value: Number(rows[0]?.estimate ?? 0), exact: false, source: "statistics" };
    }

    async countRowsExact(table: string, _schema?: string, signal?: AbortSignal): Promise<RowCountExact> {
        assertSafeIdentifier(table, "table");
        const conn = await this.pool.getConnection();
        try {
            const [idRows] = await conn.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
            const connectionId = idRows[0].id;
            const onAbort = async () => {
                try {
                    await this.pool.query("KILL QUERY ?", [connectionId]);
                } catch {
                    /* ignore */
                }
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${table}\``);
                return { value: Number(rows[0].c), exact: true };
            } finally {
                signal?.removeEventListener("abort", onAbort);
            }
        } finally {
            conn.release();
        }
    }

    async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
        if (options.query.language !== "sql") {
            throw new Error(`MySQL only supports SQL queries, got "${options.query.language}"`);
        }
        const { sql, params = [] } = options.query;
        const conn = await this.pool.getConnection();
        const chunkSize = options.chunkSize ?? 500;
        try {
            // mysql2's promise-mode types don't expose stream() on the underlying
            // connection even though it exists at runtime — the promise wrapper
            // only supports request/response, so streaming requires dropping to
            // the raw callback-based connection object it wraps.
            const rawConnection = conn.connection as unknown as {
                query(
                    sql: string,
                    params: unknown[]
                ): { stream(opts: { highWaterMark: number }): import("node:stream").Readable };
            };
            const stream = rawConnection.query(sql, params).stream({ highWaterMark: chunkSize });
            let batch: Record<string, unknown>[] = [];

            const onAbort = () => stream.destroy();
            options.signal?.addEventListener("abort", onAbort, { once: true });

            try {
                for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
                    if (options.signal?.aborted) break;
                    batch.push(row);
                    if (batch.length >= chunkSize) {
                        yield { rows: batch, nextCursor: null, columns: [] };
                        batch = [];
                    }
                }
                if (batch.length) yield { rows: batch, nextCursor: null, columns: [] };
            } finally {
                options.signal?.removeEventListener("abort", onAbort);
            }
        } finally {
            conn.release();
        }
    }

    async execute(query: ExecSpec): Promise<QueryExecResult> {
        if (query.language !== "sql") {
            throw new Error(`MySQL only supports SQL queries, got "${query.language}"`);
        }
        const start = performance.now();
        const [result] = await this.pool.query(query.sql, query.params ?? []);
        const affectedRows = Array.isArray(result) ? result.length : (result as ResultSetHeader).affectedRows;
        return { columns: [], affectedRows, durationMs: performance.now() - start };
    }

    async insertRow(
        table: string,
        _schema: string | undefined,
        values: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
        assertSafeIdentifier(table, "table");
        const cols = Object.keys(values);
        for (const c of cols) assertSafeIdentifier(c, "column");
        const colList = cols.map((c) => `\`${c}\``).join(", ");
        const placeholders = cols.map(() => "?").join(", ");
        const sql = cols.length
            ? `INSERT INTO \`${table}\` (${colList}) VALUES (${placeholders})`
            : `INSERT INTO \`${table}\` () VALUES ()`;
        const [result] = await this.pool.query(sql, cols.map((c) => values[c]));
        const insertId = (result as ResultSetHeader).insertId;
        const pkCols = await this.primaryKeyColumns(table);

        if (insertId && pkCols.length === 1) {
            const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE \`${pkCols[0]}\` = ?`, [
                insertId,
            ]);
            if (rows[0]) return rows[0];
        }
        return { ...values, ...(insertId ? { [pkCols[0] ?? "id"]: insertId } : {}) };
    }

    async updateCell(
        table: string,
        _schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(column, "column");
        const pkCols = Object.keys(primaryKey);
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const setClause = `\`${column}\` = ?`;
        const whereClause = pkCols.map((c) => `\`${c}\` = ?`).join(" AND ");
        const sql = `UPDATE \`${table}\` SET ${setClause} WHERE ${whereClause}`;
        await this.pool.query(sql, [value, ...pkCols.map((c) => primaryKey[c])]);
    }

    async deleteRow(table: string, _schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void> {
        assertSafeIdentifier(table, "table");
        const pkCols = Object.keys(primaryKey);
        if (pkCols.length === 0) throw new Error("deleteRow requires at least one primary key column");
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const whereClause = pkCols.map((c) => `\`${c}\` = ?`).join(" AND ");
        await this.pool.query(`DELETE FROM \`${table}\` WHERE ${whereClause}`, pkCols.map((c) => primaryKey[c]));
    }

    watchTable(table: string, _schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void {
        assertSafeIdentifier(table, "table");
        let lastRows: Record<string, unknown>[] | null = null;
        let stopped = false;

        const poll = async () => {
            const pkCols = await this.primaryKeyColumns(table);
            const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` LIMIT ${WATCH_ROW_LIMIT}`);
            if (stopped) return;
            if (lastRows) {
                for (const event of diffTableSnapshots(lastRows, rows, pkCols)) onChange(event);
            }
            lastRows = rows; // first poll only establishes the baseline — nothing to diff against yet
        };

        const onPollError = (err: unknown) => console.error(`MySQL table-watch poll failed for "${table}":`, (err as Error).message);
        void poll().catch(onPollError);
        this.watchIntervals.set(
            table,
            setInterval(() => void poll().catch(onPollError), POLL_INTERVAL_MS)
        );

        return () => {
            stopped = true;
            const interval = this.watchIntervals.get(table);
            if (interval) clearInterval(interval);
            this.watchIntervals.delete(table);
        };
    }

    async close(): Promise<void> {
        for (const interval of this.watchIntervals.values()) clearInterval(interval);
        this.watchIntervals.clear();
        await this.pool.end();
    }
}

export const mysqlDriver: DatabaseDriver = {
    key: "mysql",
    displayName: "MySQL",
    capabilities: { transactions: true, schemas: false, streaming: true, cancellation: true, queryLanguage: "sql" },

    async testConnection(config: ConnectionConfig) {
        try {
            const conn = await mysql.createConnection({
                host: config.host,
                port: config.port ?? 3306,
                database: config.database,
                user: config.username,
                password: config.password,
                ssl: toMysqlSsl(config),
                connectTimeout: 5000,
            });
            await conn.query("SELECT 1");
            await conn.end();
            return { ok: true };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    },

    async connect(config: ConnectionConfig): Promise<DriverConnection> {
        const pool = mysql.createPool({
            host: config.host,
            port: config.port ?? 3306,
            database: config.database,
            user: config.username,
            password: config.password,
            ssl: toMysqlSsl(config),
            connectionLimit: 10,
        });
        return new MysqlConnection(config.id, pool, config.database ?? "");
    },
};

export default mysqlDriver;
