import Database from "better-sqlite3";
import {
    compileFilters,
    diffTableSnapshots,
    assertSafeIdentifier,
    keysetComparison,
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

// SQLite has no push notification for writes from other connections/processes
// (its update hook is per-connection, in-process only) — data_version is a
// counter maintained by SQLite itself that increments on any change to the
// file from any connection, so polling it is the cheapest way to notice we
// need to re-check a watched table at all before paying for a full re-query.
const POLL_INTERVAL_MS = 1000;
const WATCH_ROW_LIMIT = 1000;

// Only these ever reach the "else" branch in queryRows below (is_null/
// is_not_null/in/like are handled separately) — anything else is a request
// body forged past the frontend's own TS types, since QueryFilter.op is a
// closed union there but req.body is untyped on arrival at the server.

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

/** Cursor is `<pkColumnValue>` base64-encoded; sqlite driver only supports a single-column keyset for simplicity. */
function encodeCursor(values: unknown[]): string {
    return Buffer.from(JSON.stringify(values)).toString("base64");
}
function decodeCursor(cursor: string): unknown[] {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
    // Cursors used to encode a bare primary-key scalar; tolerate one so a
    // cursor held by an open tab across a restart still works.
    return Array.isArray(parsed) ? parsed : [parsed];
}

class SqliteConnection implements DriverConnection {
    readonly id: string;
    private db: Database.Database;
    private watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

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
                    { maxRowid: number | null } | undefined;
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
        assertSafeIdentifier(table, "table");
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
        assertSafeIdentifier(table, "table");
        for (const c of options.columns ?? []) assertSafeIdentifier(c, "column");
        for (const s of sort ?? []) assertSafeIdentifier(s.column, "column");

        const pk = this.primaryKeyColumn(table);
        const columns = this.describeColumnsSync(table);
        const selectCols = options.columns?.length ? options.columns.map((c) => `"${c}"`).join(", ") : "*";

        // The cursor must key on the *same* tuple the rows are ordered by.
        // With a sort applied, this used to order by (sortCol, pk) while the
        // cursor compared pk alone — so every page boundary after the first
        // silently skipped or repeated rows.
        const orderBy = resolveOrderBy(sort, [pk]);
        const orderCols = orderBy.map((o) => o.column);
        const descending = orderBy[0].direction === "desc";

        const where: string[] = [];
        const params: unknown[] = [];
        const quote = (identifier: string) => `"${identifier}"`;

        const pushKeyset = (values: unknown[], inclusive: boolean) => {
            where.push(
                keysetComparison(orderCols, values.length, { descending, inclusive, quote, placeholder: () => "?" })
            );
            params.push(...values);
        };

        if (afterCursor) pushKeyset(decodeCursor(afterCursor), false);
        else if (options.seek?.length) pushKeyset(options.seek.slice(0, orderCols.length), true);

        const filterSql = compileFilters(filters, {
            quote,
            bind: (value) => {
                params.push(value);
                return "?";
            },
        });
        if (filterSql) where.push(filterSql);

        const orderSql = orderBy.map((o) => `${quote(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`).join(", ");
        const sql = `SELECT ${selectCols} FROM "${table}" ${
            where.length ? "WHERE " + where.join(" AND ") : ""
        } ORDER BY ${orderSql} LIMIT ?`;
        params.push(pageSize + 1); // fetch one extra to know if there's a next page

        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
        const hasMore = rows.length > pageSize;
        const page = hasMore ? rows.slice(0, pageSize) : rows;
        const nextCursor = hasMore ? encodeCursor(orderCols.map((c) => page[page.length - 1][c])) : null;

        return { rows: page, nextCursor, columns, orderBy };
    }

    async estimateRowCount(table: string): Promise<RowCountEstimate> {
        assertSafeIdentifier(table, "table");
        // SQLite has no cheap statistics table by default; MAX(rowid) is a fast
        // approximation for rowid tables and is still O(log n) via the index.
        try {
            const row = this.db.prepare(`SELECT MAX(rowid) as m FROM "${table}"`).get() as { m: number | null };
            return { value: row.m ?? 0, exact: false, source: "statistics" };
        } catch {
            return { value: 0, exact: false, source: "unsupported" };
        }
    }

    async countRowsExact(table: string): Promise<RowCountExact> {
        assertSafeIdentifier(table, "table");
        const row = this.db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number };
        return { value: row.c, exact: true };
    }

    async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
        if (options.query.language !== "sql") {
            throw new Error(`SQLite only supports SQL queries, got "${options.query.language}"`);
        }
        const { sql, params = [] } = options.query;
        const chunkSize = options.chunkSize ?? 500;
        const stmt = this.db.prepare(sql);
        let batch: Record<string, unknown>[] = [];
        const columns: ColumnDefinition[] = [];

        for (const row of stmt.iterate(...params)) {
            if (options.signal?.aborted) return;
            batch.push(row as Record<string, unknown>);
            if (batch.length >= chunkSize) {
                yield { rows: batch, nextCursor: null, columns };
                batch = [];
            }
        }
        if (batch.length) yield { rows: batch, nextCursor: null, columns };
    }

    async execute(query: ExecSpec): Promise<QueryExecResult> {
        if (query.language !== "sql") {
            throw new Error(`SQLite only supports SQL queries, got "${query.language}"`);
        }
        const { sql, params = [] } = query;
        const start = performance.now();
        const isSelect = /^\s*(select|pragma)/i.test(sql);
        if (isSelect) {
            const rows = this.db.prepare(sql).all(...params);
            return { columns: [], affectedRows: rows.length, durationMs: performance.now() - start };
        }
        const info = this.db.prepare(sql).run(...params);
        return { columns: [], affectedRows: info.changes, durationMs: performance.now() - start };
    }

    async insertRow(
        table: string,
        _schema: string | undefined,
        values: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
        assertSafeIdentifier(table, "table");
        const cols = Object.keys(values);
        for (const c of cols) assertSafeIdentifier(c, "column");
        const placeholders = cols.map(() => "?").join(", ");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;
        const info = this.db.prepare(sql).run(...cols.map((c) => values[c]));
        const pk = this.primaryKeyColumn(table);
        const inserted = this.db.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(info.lastInsertRowid) as
            Record<string, unknown> | undefined;
        return inserted ?? { ...values, [pk]: info.lastInsertRowid };
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
        const setClause = `"${column}" = ?`;
        const whereClause = pkCols.map((c) => `"${c}" = ?`).join(" AND ");
        const sql = `UPDATE "${table}" SET ${setClause} WHERE ${whereClause}`;
        this.db.prepare(sql).run(value, ...pkCols.map((c) => primaryKey[c]));
    }

    async deleteRow(table: string, _schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void> {
        assertSafeIdentifier(table, "table");
        const pkCols = Object.keys(primaryKey);
        if (pkCols.length === 0) throw new Error("deleteRow requires at least one primary key column");
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const whereClause = pkCols.map((c) => `"${c}" = ?`).join(" AND ");
        this.db.prepare(`DELETE FROM "${table}" WHERE ${whereClause}`).run(...pkCols.map((c) => primaryKey[c]));
    }

    watchTable(table: string, _schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void {
        assertSafeIdentifier(table, "table");
        const pkCols = [this.primaryKeyColumn(table)];
        const readSnapshot = () =>
            this.db.prepare(`SELECT * FROM "${table}" LIMIT ${WATCH_ROW_LIMIT}`).all() as Record<string, unknown>[];
        const readDataVersion = () =>
            (this.db.pragma("data_version", { simple: false }) as { data_version: number }[])[0].data_version;

        let lastDataVersion = readDataVersion();
        let lastRows = readSnapshot(); // baseline — first real change is what gets diffed, not the table's existing contents

        this.watchIntervals.set(
            table,
            setInterval(() => {
                try {
                    const dataVersion = readDataVersion();
                    if (dataVersion === lastDataVersion) return;
                    lastDataVersion = dataVersion;
                    const rows = readSnapshot();
                    for (const event of diffTableSnapshots(lastRows, rows, pkCols)) onChange(event);
                    lastRows = rows;
                } catch (err) {
                    console.error(`SQLite table-watch poll failed for "${table}":`, (err as Error).message);
                }
            }, POLL_INTERVAL_MS)
        );

        return () => {
            const interval = this.watchIntervals.get(table);
            if (interval) clearInterval(interval);
            this.watchIntervals.delete(table);
        };
    }

    async close(): Promise<void> {
        for (const interval of this.watchIntervals.values()) clearInterval(interval);
        this.watchIntervals.clear();
        this.db.close();
    }
}

export const sqliteDriver: DatabaseDriver = {
    key: "sqlite",
    displayName: "SQLite",
    capabilities: { transactions: true, schemas: false, streaming: true, cancellation: true, queryLanguage: "sql" },

    async testConnection(config: ConnectionConfig) {
        try {
            const db = new Database(config.filePath ?? ":memory:", {
                readonly: true,
                fileMustExist: !!config.filePath,
            });
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
