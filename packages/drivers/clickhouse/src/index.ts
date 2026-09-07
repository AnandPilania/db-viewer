import {
    diffTableSnapshots,
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

// ClickHouse has no trigger/CDC mechanism at all (it's OLAP, not OLTP) —
// poll-and-diff is the only option. UPDATE/DELETE are async mutations (see
// class doc comment below), so changes from those may lag behind the poll
// by more than one interval — that's ClickHouse's own behavior, not a bug
// in this polling.
const POLL_INTERVAL_MS = 2000;
const WATCH_ROW_LIMIT = 1000;

// Only these ever reach the "else" branch in queryRows below (is_null/
// is_not_null/in/like are handled separately) — anything else is a request
// body forged past the frontend's own TS types, since QueryFilter.op is a
// closed union there but req.body is untyped on arrival at the server.
const SAFE_COMPARISON_OPS = new Set(["=", "!=", ">", ">=", "<", "<="]);

/**
 * ClickHouse has no official lightweight HTTP-only client that also
 * supports very old server versions cleanly, and its HTTP interface is
 * simple enough (plain SQL in, JSON/JSONEachRow out) that talking to it
 * directly with `fetch` avoids a dependency entirely.
 *
 * Two ClickHouse-specific realities worth flagging:
 *  - UInt64/Int64 values come back from the HTTP interface as JSON
 *    *strings*, not numbers, to avoid silent precision loss (JS numbers
 *    can't exactly represent the full 64-bit range). We pass them through
 *    as-is rather than coercing, same as every other driver does for
 *    values it can't safely narrow.
 *  - UPDATE/DELETE are ClickHouse "mutations" (`ALTER TABLE ... UPDATE/DELETE`),
 *    which apply *asynchronously in the background*, not transactionally
 *    like a row-store's UPDATE. A read immediately after a write may not
 *    reflect it yet. This is standard ClickHouse behavior, not a bug in
 *    this driver — MergeTree is fundamentally an append/merge-oriented
 *    columnar engine, not built for row-level OLTP mutation.
 */

function mapClickHouseType(rawType: string): { type: ColumnType; nullable: boolean } {
    const nullable = rawType.startsWith("Nullable(") && rawType.endsWith(")");
    const inner = nullable ? rawType.slice("Nullable(".length, -1) : rawType;

    let type: ColumnType = "unknown";
    if (/^(U?Int\d+|Float\d+|Decimal)/.test(inner)) type = "number";
    if (/^(String|FixedString|UUID|Enum)/.test(inner)) type = "string";
    if (/^DateTime/.test(inner)) type = "datetime";
    if (inner === "Date") type = "date";
    if (/^(Array|Tuple|Map|Nested)/.test(inner)) type = "json";
    if (inner === "Bool" || inner === "UInt8") type = "number"; // ClickHouse has no real boolean type pre-v22

    return { type, nullable };
}

function toLiteral(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    // Everything else (including numeric-looking strings from UInt64 fields)
    // is escaped and quoted — ClickHouse accepts a quoted numeral for
    // numeric columns via implicit cast, so this stays correct without
    // needing to know the column's declared type at literal-build time.
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function encodeCursor(values: unknown[]): string {
    return Buffer.from(JSON.stringify(values)).toString("base64");
}
function decodeCursor(cursor: string): unknown[] {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
}

interface ChJsonResponse {
    meta: { name: string; type: string }[];
    data: Record<string, unknown>[];
    rows: number;
}

class ClickHouseConnection implements DriverConnection {
    readonly id: string;
    private baseUrl: string;
    private database: string;
    private watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

    constructor(id: string, baseUrl: string, database: string) {
        this.id = id;
        this.baseUrl = baseUrl;
        this.database = database;
    }

    private async httpQuery(sql: string): Promise<ChJsonResponse> {
        const res = await fetch(`${this.baseUrl}/?database=${encodeURIComponent(this.database)}`, {
            method: "POST",
            body: sql,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text.trim() || `ClickHouse request failed (${res.status})`);
        if (!text.trim()) return { meta: [], data: [], rows: 0 };
        return JSON.parse(text);
    }

    /** For statements with no result set (DDL, INSERT, ALTER ... UPDATE/DELETE). */
    private async httpExecute(sql: string): Promise<void> {
        const res = await fetch(`${this.baseUrl}/?database=${encodeURIComponent(this.database)}`, {
            method: "POST",
            body: sql,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(text.trim() || `ClickHouse request failed (${res.status})`);
        }
    }

    async listSchemas(): Promise<SchemaSummary[]> {
        const dbs = await this.httpQuery("SELECT name FROM system.databases FORMAT JSON");
        const summaries: SchemaSummary[] = [];
        for (const row of dbs.data) {
            const name = String(row.name);
            const tables = await this.listTablesIn(name);
            summaries.push({ name, tables: tables.map((t) => ({ schema: name, name: t.name, kind: t.kind })) });
        }
        return summaries;
    }

    private async listTablesIn(database: string): Promise<TableDefinition[]> {
        const result = await this.httpQuery(
            `SELECT name, engine FROM system.tables WHERE database = ${toLiteral(database)} FORMAT JSON`
        );
        const tables: TableDefinition[] = [];
        for (const row of result.data) {
            const name = String(row.name);
            tables.push({
                schema: database,
                name,
                kind: String(row.engine).includes("View") ? "view" : "table",
                columns: await this.describeColumns(database, name),
            });
        }
        return tables;
    }

    async listTables(schema?: string): Promise<TableDefinition[]> {
        return this.listTablesIn(schema ?? this.database);
    }

    private async describeColumns(database: string, table: string): Promise<ColumnDefinition[]> {
        const result = await this.httpQuery(
            `SELECT name, type, is_in_primary_key FROM system.columns ` +
            `WHERE database = ${toLiteral(database)} AND table = ${toLiteral(table)} FORMAT JSON`
        );
        return result.data.map((r) => {
            const { type, nullable } = mapClickHouseType(String(r.type));
            return {
                name: String(r.name),
                type,
                nativeType: String(r.type),
                nullable,
                isPrimaryKey: Number(r.is_in_primary_key) === 1,
                isForeignKey: false, // ClickHouse has no foreign key concept
            };
        });
    }

    async describeTable(table: string, schema?: string): Promise<TableDefinition> {
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        return { schema: database, name: table, kind: "table", columns: await this.describeColumns(database, table) };
    }

    private async primaryKeyColumns(database: string, table: string): Promise<string[]> {
        const columns = await this.describeColumns(database, table);
        const pks = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
        return pks.length ? pks : [columns[0]?.name].filter(Boolean) as string[];
    }

    async queryRows(options: QueryRowsOptions): Promise<QueryRowsResult> {
        const database = options.schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(options.table, "table");
        for (const c of options.columns ?? []) assertSafeIdentifier(c, "column");
        for (const f of options.filters ?? []) assertSafeIdentifier(f.column, "column");

        const pkCols = await this.primaryKeyColumns(database, options.table);
        const columns = await this.describeColumns(database, options.table);
        const selectCols = options.columns?.length ? options.columns.map((c) => `\`${c}\``).join(", ") : "*";

        const where: string[] = [];
        if (options.afterCursor) {
            const cursorVals = decodeCursor(options.afterCursor);
            const tuple = pkCols.map((c) => `\`${c}\``).join(", ");
            // Cursor values for UInt64/Int64 columns arrive as JSON strings (see
            // class doc comment on why) — quoting them here would compare a
            // numeric column against a string literal, which this ClickHouse
            // version rejects outright rather than casting. Use the pk column's
            // known type to decide whether to emit a bare numeral or a quoted
            // string literal.
            const literals = cursorVals
                .map((v, i) => {
                    const colDef = columns.find((c) => c.name === pkCols[i]);
                    return colDef?.type === "number" ? String(v) : toLiteral(v);
                })
                .join(", ");
            where.push(`(${tuple}) > (${literals})`);
        }
        for (const f of options.filters ?? []) {
            if (f.op === "is_null") where.push(`\`${f.column}\` IS NULL`);
            else if (f.op === "is_not_null") where.push(`\`${f.column}\` IS NOT NULL`);
            else if (f.op === "like") where.push(`\`${f.column}\` LIKE ${toLiteral(f.value)}`);
            else if (f.op === "in" && Array.isArray(f.value)) {
                where.push(`\`${f.column}\` IN (${f.value.map((v) => toLiteral(v)).join(", ")})`);
            } else {
                if (!SAFE_COMPARISON_OPS.has(f.op)) throw new Error(`Invalid filter operator: ${JSON.stringify(f.op)}`);
                where.push(`\`${f.column}\` ${f.op} ${toLiteral(f.value)}`);
            }
        }

        const orderBy = pkCols.map((c) => `\`${c}\` ASC`).join(", ");
        const sql =
            `SELECT ${selectCols} FROM \`${database}\`.\`${options.table}\` ` +
            `${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy} LIMIT ${options.pageSize + 1} FORMAT JSON`;

        const result = await this.httpQuery(sql);
        const hasMore = result.data.length > options.pageSize;
        const page = hasMore ? result.data.slice(0, options.pageSize) : result.data;
        const nextCursor = hasMore ? encodeCursor(pkCols.map((c) => page[page.length - 1][c])) : null;

        return { rows: page, nextCursor, columns };
    }

    async estimateRowCount(table: string, schema?: string): Promise<RowCountEstimate> {
        // ClickHouse's system.tables doesn't expose free row-count statistics
        // on every version, but `count()` on a columnar MergeTree table is
        // cheap (no full-row materialization needed) — cheap enough to use as
        // the "fast" estimate path here even though it's a real query.
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        const result = await this.httpQuery(`SELECT count() AS c FROM \`${database}\`.\`${table}\` FORMAT JSON`);
        return { value: Number(result.data[0]?.c ?? 0), exact: false, source: "statistics" };
    }

    async countRowsExact(table: string, schema?: string): Promise<RowCountExact> {
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        const result = await this.httpQuery(`SELECT count() AS c FROM \`${database}\`.\`${table}\` FORMAT JSON`);
        return { value: Number(result.data[0]?.c ?? 0), exact: true };
    }

    async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
        if (options.query.language !== "sql") {
            throw new Error(`ClickHouse only supports SQL queries, got "${options.query.language}"`);
        }
        const chunkSize = options.chunkSize ?? 500;
        const sql = options.query.sql.trim().replace(/;\s*$/, "") + " FORMAT JSONEachRow";
        const res = await fetch(`${this.baseUrl}/?database=${encodeURIComponent(this.database)}`, {
            method: "POST",
            body: sql,
            signal: options.signal,
        });
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(text.trim() || `ClickHouse request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let batch: Record<string, unknown>[] = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                batch.push(JSON.parse(line));
                if (batch.length >= chunkSize) {
                    yield { rows: batch, nextCursor: null, columns: [] };
                    batch = [];
                }
            }
        }
        if (buffer.trim()) batch.push(JSON.parse(buffer));
        if (batch.length) yield { rows: batch, nextCursor: null, columns: [] };
    }

    async execute(query: ExecSpec): Promise<QueryExecResult> {
        if (query.language !== "sql") {
            throw new Error(`ClickHouse only supports SQL queries, got "${query.language}"`);
        }
        const start = performance.now();
        const trimmed = query.sql.trim();
        const isSelect = /^\s*(select|show|describe|desc)\b/i.test(trimmed);
        if (isSelect) {
            const result = await this.httpQuery(trimmed.replace(/;\s*$/, "") + " FORMAT JSON");
            return {
                columns: result.meta.map((m) => {
                    const { type, nullable } = mapClickHouseType(m.type);
                    return { name: m.name, type, nativeType: m.type, nullable, isPrimaryKey: false, isForeignKey: false };
                }),
                affectedRows: result.rows,
                durationMs: performance.now() - start,
            };
        }
        await this.httpExecute(trimmed);
        return { columns: [], durationMs: performance.now() - start };
    }

    async insertRow(
        table: string,
        schema: string | undefined,
        values: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        const cols = Object.keys(values);
        for (const c of cols) assertSafeIdentifier(c, "column");
        const colList = cols.map((c) => `\`${c}\``).join(", ");
        const valueList = cols.map((c) => toLiteral(values[c])).join(", ");
        await this.httpExecute(`INSERT INTO \`${database}\`.\`${table}\` (${colList}) VALUES (${valueList})`);
        return values; // ClickHouse has no RETURNING / auto-generated keys to read back generically
    }

    async deleteRow(table: string, schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void> {
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        const pkCols = Object.keys(primaryKey);
        if (pkCols.length === 0) throw new Error("deleteRow requires at least one primary key column");
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const whereClause = pkCols.map((c) => `\`${c}\` = ${toLiteral(primaryKey[c])}`).join(" AND ");
        // ALTER ... DELETE is an async ClickHouse "mutation" — see class doc comment.
        await this.httpExecute(`ALTER TABLE \`${database}\`.\`${table}\` DELETE WHERE ${whereClause}`);
    }

    async updateCell(
        table: string,
        schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        assertSafeIdentifier(column, "column");
        const pkCols = Object.keys(primaryKey);
        if (pkCols.length === 0) throw new Error("updateCell requires at least one primary key column");
        for (const c of pkCols) assertSafeIdentifier(c, "column");
        const whereClause = pkCols.map((c) => `\`${c}\` = ${toLiteral(primaryKey[c])}`).join(" AND ");
        // ALTER ... UPDATE is an async ClickHouse "mutation" — see class doc comment.
        await this.httpExecute(`ALTER TABLE \`${database}\`.\`${table}\` UPDATE \`${column}\` = ${toLiteral(value)} WHERE ${whereClause}`);
    }

    watchTable(table: string, schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void {
        const database = schema ?? this.database;
        assertSafeIdentifier(database, "schema");
        assertSafeIdentifier(table, "table");
        let lastRows: Record<string, unknown>[] | null = null;
        let stopped = false;

        const poll = async () => {
            const pkCols = await this.primaryKeyColumns(database, table);
            const result = await this.httpQuery(
                `SELECT * FROM \`${database}\`.\`${table}\` LIMIT ${WATCH_ROW_LIMIT} FORMAT JSON`
            );
            if (stopped) return;
            if (lastRows) {
                for (const event of diffTableSnapshots(lastRows, result.data, pkCols)) onChange(event);
            }
            lastRows = result.data; // first poll only establishes the baseline — nothing to diff against yet
        };

        const onPollError = (err: unknown) => console.error(`ClickHouse table-watch poll failed for "${table}":`, (err as Error).message);
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
    }
}

export const clickhouseDriver: DatabaseDriver = {
    key: "clickhouse",
    displayName: "ClickHouse",
    capabilities: { transactions: false, schemas: true, streaming: true, cancellation: true, queryLanguage: "sql" },

    async testConnection(config: ConnectionConfig) {
        const baseUrl = `http://${config.host ?? "localhost"}:${config.port ?? 8123}`;
        try {
            const res = await fetch(`${baseUrl}/?query=${encodeURIComponent("SELECT 1")}`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return { ok: false, message: await res.text() };
            return { ok: true };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    },

    async connect(config: ConnectionConfig): Promise<DriverConnection> {
        const baseUrl = `http://${config.host ?? "localhost"}:${config.port ?? 8123}`;
        return new ClickHouseConnection(config.id, baseUrl, config.database ?? "default");
    },
};

export default clickhouseDriver;
