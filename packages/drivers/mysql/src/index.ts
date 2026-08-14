import mysql from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
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

    constructor(id: string, pool: Pool, database: string) {
        this.id = id;
        this.pool = pool;
        this.database = database;
    }

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
        const conn = await this.pool.getConnection();
        const chunkSize = options.chunkSize ?? 500;
        try {
            const rawConnection = conn.connection as unknown as {
                query(
                    sql: string,
                    params: unknown[]
                ): { stream(opts: { highWaterMark: number }): import("node:stream").Readable };
            };
            const stream = rawConnection.query(options.sql, options.params ?? []).stream({ highWaterMark: chunkSize });
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

    async execute(sql: string, params: unknown[] = []): Promise<QueryExecResult> {
        const start = performance.now();
        const [result] = await this.pool.query(sql, params);
        const affectedRows = Array.isArray(result) ? result.length : (result as ResultSetHeader).affectedRows;
        return { columns: [], affectedRows, durationMs: performance.now() - start };
    }

    async updateCell(
        table: string,
        _schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        const pkCols = Object.keys(primaryKey);
        const setClause = `\`${column}\` = ?`;
        const whereClause = pkCols.map((c) => `\`${c}\` = ?`).join(" AND ");
        const sql = `UPDATE \`${table}\` SET ${setClause} WHERE ${whereClause}`;
        await this.pool.query(sql, [value, ...pkCols.map((c) => primaryKey[c])]);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

export const mysqlDriver: DatabaseDriver = {
    key: "mysql",
    displayName: "MySQL",
    capabilities: { transactions: true, schemas: false, streaming: true, cancellation: true },

    async testConnection(config: ConnectionConfig) {
        try {
            const conn = await mysql.createConnection({
                host: config.host,
                port: config.port ?? 3306,
                database: config.database,
                user: config.username,
                password: config.password,
                ssl: config.ssl ? {} : undefined,
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
            ssl: config.ssl ? {} : undefined,
            connectionLimit: 10,
        });
        return new MysqlConnection(config.id, pool, config.database ?? "");
    },
};

export default mysqlDriver;
