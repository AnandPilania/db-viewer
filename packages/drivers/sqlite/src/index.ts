import Database from "better-sqlite3";
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

function mapSqliteType(declared: string): ColumnType {
    const t = declared.toUpperCase();
    if (t.includes("INT")) return "number";
    if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUMERIC")) return "number";
    if (t.includes("BOOL")) return "boolean";
    if (t.includes("DATE") || t.includes("TIME")) return "datetime";
    if (t.includes("BLOB")) return "binary";
    if (t.includes("JSON")) return "json";
    if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "string";
    return "unknown";
}

function encodeCursor(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64");
}
function decodeCursor(cursor: string): unknown {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
}

class SqliteConnection implements DriverConnection {
    readonly id: string;
    private db: Database.Database;

    constructor(id: string, db: Database.Database) {
        this.id = id;
        this.db = db;
    }

    async listSchemas(): Promise<SchemaSummary[]> {
        const tables = await this.listTables();
        return [{ name: "main", tables: tables.map((t) => ({ name: t.name, kind: t.kind })) }];
    }

    async listTables(): Promise<TableDefinition[]> {
        const rows = this.db
            .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string; type: string }[];

        return rows.map((r) => {
            let estimatedRowCount: number | undefined;
            try {
                const stat = this.db.prepare(`SELECT MAX(rowid) as maxRowid FROM "${r.name}"`).get() as
                    | { maxRowid: number | null }
                    | undefined;
                estimatedRowCount = stat?.maxRowid ?? undefined;
            } catch {
                estimatedRowCount = undefined;
            }
            return {
                name: r.name,
                kind: r.type === "view" ? "view" : "table",
                columns: this.describeColumnsSync(r.name),
                estimatedRowCount,
            };
        });
    }

    private describeColumnsSync(table: string): ColumnDefinition[] {
        const cols = this.db.prepare(`PRAGMA table_info("${table}")`).all() as {
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }[];
        const fks = this.db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
            from: string;
            table: string;
            to: string;
        }[];
        return cols.map((c) => {
            const fk = fks.find((f) => f.from === c.name);
            return {
                name: c.name,
                type: mapSqliteType(c.type || ""),
                nativeType: c.type || "TEXT",
                nullable: c.notnull === 0,
                isPrimaryKey: c.pk > 0,
                isForeignKey: !!fk,
                references: fk ? { table: fk.table, column: fk.to } : undefined,
                defaultValue: c.dflt_value,
            };
        });
    }

    async describeTable(table: string): Promise<TableDefinition> {
        return {
            name: table,
            kind: "table",
            columns: this.describeColumnsSync(table),
        };
    }

    private primaryKeyColumn(table: string): string {
        const cols = this.describeColumnsSync(table);
        return cols.find((c) => c.isPrimaryKey)?.name ?? "rowid";
    }

    async queryRows(options: QueryRowsOptions): Promise<QueryRowsResult> {
        const { table, pageSize, afterCursor, filters, sort } = options;
        const pk = this.primaryKeyColumn(table);
        const columns = this.describeColumnsSync(table);
        const selectCols = options.columns?.length ? options.columns.map((c) => `"${c}"`).join(", ") : "*";

        const where: string[] = [];
        const params: unknown[] = [];

        if (afterCursor) {
            where.push(`"${pk}" > ?`);
            params.push(decodeCursor(afterCursor));
        }
        for (const f of filters ?? []) {
            if (f.op === "is_null") where.push(`"${f.column}" IS NULL`);
            else if (f.op === "is_not_null") where.push(`"${f.column}" IS NOT NULL`);
            else if (f.op === "like") {
                where.push(`"${f.column}" LIKE ?`);
                params.push(f.value);
            } else if (f.op === "in" && Array.isArray(f.value)) {
                where.push(`"${f.column}" IN (${f.value.map(() => "?").join(",")})`);
                params.push(...f.value);
            } else {
                where.push(`"${f.column}" ${f.op} ?`);
                params.push(f.value);
            }
        }

        const orderBy = sort?.length
            ? sort.map((s) => `"${s.column}" ${s.direction.toUpperCase()}`).join(", ") + `, "${pk}" ASC`
            : `"${pk}" ASC`;

        const sql = `SELECT ${selectCols} FROM "${table}" ${where.length ? "WHERE " + where.join(" AND ") : ""
            } ORDER BY ${orderBy} LIMIT ?`;
        params.push(pageSize + 1); // fetch one extra to know if there's a next page

        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
        const hasMore = rows.length > pageSize;
        const page = hasMore ? rows.slice(0, pageSize) : rows;
        const nextCursor = hasMore ? encodeCursor((page[page.length - 1] as Record<string, unknown>)[pk]) : null;

        return { rows: page, nextCursor, columns };
    }

    async estimateRowCount(table: string): Promise<RowCountEstimate> {
        try {
            const row = this.db.prepare(`SELECT MAX(rowid) as m FROM "${table}"`).get() as { m: number | null };
            return { value: row.m ?? 0, exact: false, source: "statistics" };
        } catch {
            return { value: 0, exact: false, source: "unsupported" };
        }
    }

    async countRowsExact(table: string): Promise<RowCountExact> {
        const row = this.db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number };
        return { value: row.c, exact: true };
    }

    async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
        const chunkSize = options.chunkSize ?? 500;
        const stmt = this.db.prepare(options.sql);
        let batch: Record<string, unknown>[] = [];
        const columns: ColumnDefinition[] = [];

        for (const row of stmt.iterate(...(options.params ?? []))) {
            if (options.signal?.aborted) return;
            batch.push(row as Record<string, unknown>);
            if (batch.length >= chunkSize) {
                yield { rows: batch, nextCursor: null, columns };
                batch = [];
            }
        }
        if (batch.length) yield { rows: batch, nextCursor: null, columns };
    }

    async execute(sql: string, params: unknown[] = []): Promise<QueryExecResult> {
        const start = performance.now();
        const isSelect = /^\s*(select|pragma)/i.test(sql);
        if (isSelect) {
            const rows = this.db.prepare(sql).all(...params);
            return { columns: [], affectedRows: rows.length, durationMs: performance.now() - start };
        }
        const info = this.db.prepare(sql).run(...params);
        return { columns: [], affectedRows: info.changes, durationMs: performance.now() - start };
    }

    async updateCell(
        table: string,
        _schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        const pkCols = Object.keys(primaryKey);
        const setClause = `"${column}" = ?`;
        const whereClause = pkCols.map((c) => `"${c}" = ?`).join(" AND ");
        const sql = `UPDATE "${table}" SET ${setClause} WHERE ${whereClause}`;
        this.db.prepare(sql).run(value, ...pkCols.map((c) => primaryKey[c]));
    }

    async close(): Promise<void> {
        this.db.close();
    }
}

export const sqliteDriver: DatabaseDriver = {
    key: "sqlite",
    displayName: "SQLite",
    capabilities: { transactions: true, schemas: false, streaming: true, cancellation: true },

    async testConnection(config: ConnectionConfig) {
        try {
            const db = new Database(config.filePath ?? ":memory:", { readonly: true, fileMustExist: !!config.filePath });
            db.close();
            return { ok: true };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    },

    async connect(config: ConnectionConfig): Promise<DriverConnection> {
        const db = new Database(config.filePath ?? ":memory:");
        db.pragma("journal_mode = WAL");
        return new SqliteConnection(config.id, db);
    },
};

export default sqliteDriver;
