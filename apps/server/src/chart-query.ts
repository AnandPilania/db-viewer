import type { ConnectionConfig, DriverConnection, QuerySpec } from "@pilaniaanand/driver-interface";
import type { Widget } from "./models.js";

/** SQL-family drivers build a validated SQL string; MongoDB and Redis build their own native query shapes instead (see fetchMongoWidgetData / fetchRedisWidgetData). ClickHouse is SQL too, but its driver's streamQuery doesn't bind params (see chLiteral below), so it gets literal-embedded values instead of placeholders. */
const SQL_DRIVERS = new Set(["postgres", "mysql", "sqlite", "clickhouse"]);

function quoteIdent(driver: string, ident: string): string {
    return driver === "mysql" || driver === "clickhouse" ? `\`${ident}\`` : `"${ident}"`;
}

function placeholder(driver: string, index: number): string {
    return driver === "postgres" ? `$${index}` : "?";
}

/** ClickHouse's HTTP interface, as this driver calls it, takes a single SQL string with no separate parameter binding — so filter values are embedded as escaped literals instead of `$1`/`?` placeholders. */
function chLiteral(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function collectRows(conn: DriverConnection, query: QuerySpec): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for await (const chunk of conn.streamQuery({ query })) {
        rows.push(...chunk.rows);
    }
    return rows;
}

export interface WidgetData {
    rows: Record<string, unknown>[];
    xKey: string;
    yKey: string;
}

/**
 * Builds and runs the SQL for a widget's chart, validating every column
 * name the widget references against the table's real, driver-reported
 * schema first. SQL has no parameterized-identifier syntax (only values
 * can be bound with $1/?), so this allowlist check is what stands in for
 * that — a widget can only ever reference a table/column that genuinely
 * exists, never arbitrary interpolated text.
 */
export async function fetchWidgetData(
    conn: DriverConnection,
    config: ConnectionConfig,
    widget: Widget
): Promise<WidgetData> {
    if (config.driver === "mongodb") return fetchMongoWidgetData(conn, widget);
    if (config.driver === "redis") return fetchRedisWidgetData(conn, widget);
    if (!SQL_DRIVERS.has(config.driver)) {
        throw new Error(`Dashboard charts aren't supported for ${config.driver} yet.`);
    }
    const driver = config.driver;

    const tables = await conn.listTables(widget.schema);
    const tableDef = tables.find((t) => t.name === widget.table);
    if (!tableDef) throw new Error(`Table "${widget.table}" not found`);
    const validColumns = new Set(tableDef.columns.map((c) => c.name));

    for (const field of [widget.xField, widget.yField, ...(widget.filters ?? []).map((f) => f.column)]) {
        if (field && !validColumns.has(field)) throw new Error(`Column "${field}" does not exist on ${widget.table}`);
    }

    const schemaPrefix = widget.schema ? `${quoteIdent(driver, widget.schema)}.` : "";
    const tableRef = `${schemaPrefix}${quoteIdent(driver, widget.table)}`;

    const params: unknown[] = [];
    let paramIndex = 1;
    const whereClauses: string[] = [];
    for (const f of widget.filters ?? []) {
        if (driver === "clickhouse") {
            whereClauses.push(`${quoteIdent(driver, f.column)} = ${chLiteral(f.value)}`);
        } else {
            whereClauses.push(`${quoteIdent(driver, f.column)} = ${placeholder(driver, paramIndex++)}`);
            params.push(f.value);
        }
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

    if (widget.chartType === "table") {
        const rows = await collectRows(conn, { language: "sql", sql: `SELECT * FROM ${tableRef} ${whereSql} LIMIT 50`, params });
        return { rows, xKey: "", yKey: "" };
    }

    const yExpr =
        widget.aggregation === "count"
            ? "COUNT(*)"
            : `${widget.aggregation.toUpperCase()}(${quoteIdent(driver, widget.yField!)})`;

    if (widget.chartType === "number") {
        const rows = await collectRows(conn, { language: "sql", sql: `SELECT ${yExpr} AS y FROM ${tableRef} ${whereSql}`, params });
        return { rows, xKey: "", yKey: "y" };
    }

    // bar / line / pie — grouped aggregation
    if (!widget.xField) throw new Error(`${widget.chartType} charts need an x-axis column`);
    const xIdent = quoteIdent(driver, widget.xField);
    const sql = `SELECT ${xIdent} AS x, ${yExpr} AS y FROM ${tableRef} ${whereSql} GROUP BY ${xIdent} ORDER BY y DESC LIMIT 50`;
    const rows = await collectRows(conn, { language: "sql", sql, params });
    return { rows, xKey: "x", yKey: "y" };
}

/**
 * MongoDB has no SQL, so this builds a validated aggregation pipeline
 * instead of a query string — same allowlist principle as the SQL path:
 * every field the widget references is checked against the collection's
 * inferred schema (from `listTables`) before it goes anywhere near a
 * `$group`/`$match` stage.
 */
async function fetchMongoWidgetData(conn: DriverConnection, widget: Widget): Promise<WidgetData> {
    const collections = await conn.listTables();
    const collDef = collections.find((c) => c.name === widget.table);
    if (!collDef) throw new Error(`Collection "${widget.table}" not found`);
    const validFields = new Set(collDef.columns.map((c) => c.name));

    for (const field of [widget.xField, widget.yField, ...(widget.filters ?? []).map((f) => f.column)]) {
        if (field && !validFields.has(field)) throw new Error(`Field "${field}" does not exist on ${widget.table}`);
    }

    const match: Record<string, unknown> = {};
    for (const f of widget.filters ?? []) match[f.column] = f.value;

    if (widget.chartType === "table") {
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, filter: match, limit: 50 });
        return { rows, xKey: "", yKey: "" };
    }

    const accumulator =
        widget.aggregation === "count" ? { $sum: 1 } : { [`$${widget.aggregation}`]: `$${widget.yField}` };

    const pipeline: Record<string, unknown>[] = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });

    if (widget.chartType === "number") {
        pipeline.push({ $group: { _id: null, y: accumulator } });
        pipeline.push({ $project: { _id: 0, y: 1 } });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "", yKey: "y" };
    }

    // bar / line / pie — grouped aggregation
    if (!widget.xField) throw new Error(`${widget.chartType} charts need an x-axis column`);
    pipeline.push({ $group: { _id: `$${widget.xField}`, y: accumulator } });
    pipeline.push({ $sort: { y: -1 } });
    pipeline.push({ $limit: 50 });
    pipeline.push({ $project: { x: "$_id", y: 1, _id: 0 } });

    const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
    return { rows, xKey: "x", yKey: "y" };
}

/**
 * Redis widgets are intentionally limited: this driver's data model is one
 * row per KEY (see redis driver's doc comment), and there's no field that
 * meaningfully groups across keys the way a SQL column does — so bar/line/
 * pie charts aren't offered. "number" (a key count for the type) and
 * "table" (a browse) are the two shapes that actually mean something here.
 */
async function fetchRedisWidgetData(conn: DriverConnection, widget: Widget): Promise<WidgetData> {
    if (widget.chartType === "table") {
        const page = await conn.queryRows({ table: widget.table, pageSize: 50, afterCursor: null });
        return { rows: page.rows, xKey: "", yKey: "" };
    }
    if (widget.chartType === "number") {
        const count = await conn.countRowsExact(widget.table);
        return { rows: [{ y: count.value }], xKey: "", yKey: "y" };
    }
    throw new Error(`Redis widgets only support "number" and "table" chart types — there's no field to group ${widget.chartType} charts by across keys.`);
}
