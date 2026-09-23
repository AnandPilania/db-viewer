import { assertSafeIdentifier, MetadataCache, type ConnectionConfig, type DriverConnection, type QuerySpec } from "@pilaniaanand/driver-interface";
import { chartShapeOf } from "./chart-shapes.js";
import type { FilterOperator, TimeBucket, Widget, WidgetFilter } from "./models.js";

/**
 * Defence in depth against the widget store, not against the HTTP client.
 *
 * routes/widgets.ts validates on the way in, but widgets.json predates that
 * validation — anything already on disk was written unchecked, and both
 * values below are concatenated into SQL below (`aggregation` as a function
 * name, `schema` as a quoted identifier). So they are re-checked here, where
 * the string actually meets the query text.
 */
const SQL_AGGREGATIONS = new Set(["count", "sum", "avg", "min", "max"]);

function assertQueryableWidget(widget: Widget): void {
    if (!SQL_AGGREGATIONS.has(widget.aggregation)) {
        throw new Error(`Unsupported aggregation: ${JSON.stringify(widget.aggregation)}`);
    }
    if (widget.schema !== undefined) assertSafeIdentifier(widget.schema, "schema");
    assertSafeIdentifier(widget.table, "table");
}

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

/**
 * Calendar truncation per SQL dialect.
 *
 * Only Postgres has a portable `date_trunc`, so the others get their own
 * expression. Every entry is our own literal SQL selected by a validated
 * enum key — the column identifier is the only interpolated value, and it is
 * already allowlisted against the live schema by the caller.
 */
const BUCKET_SQL: Record<string, Record<TimeBucket, (col: string) => string>> = {
    postgres: {
        day: (c) => `date_trunc('day', ${c})`,
        week: (c) => `date_trunc('week', ${c})`,
        month: (c) => `date_trunc('month', ${c})`,
        quarter: (c) => `date_trunc('quarter', ${c})`,
        year: (c) => `date_trunc('year', ${c})`,
    },
    clickhouse: {
        day: (c) => `toStartOfDay(${c})`,
        week: (c) => `toStartOfWeek(${c})`,
        month: (c) => `toStartOfMonth(${c})`,
        quarter: (c) => `toStartOfQuarter(${c})`,
        year: (c) => `toStartOfYear(${c})`,
    },
    mysql: {
        day: (c) => `DATE_FORMAT(${c}, '%Y-%m-%d')`,
        week: (c) => `DATE_FORMAT(${c}, '%x-W%v')`,
        month: (c) => `DATE_FORMAT(${c}, '%Y-%m-01')`,
        quarter: (c) => `CONCAT(YEAR(${c}), '-Q', QUARTER(${c}))`,
        year: (c) => `DATE_FORMAT(${c}, '%Y-01-01')`,
    },
    sqlite: {
        day: (c) => `strftime('%Y-%m-%d', ${c})`,
        week: (c) => `strftime('%Y-W%W', ${c})`,
        month: (c) => `strftime('%Y-%m-01', ${c})`,
        quarter: (c) => `strftime('%Y', ${c}) || '-Q' || ((CAST(strftime('%m', ${c}) AS INTEGER) + 2) / 3)`,
        year: (c) => `strftime('%Y-01-01', ${c})`,
    },
};

/** Mongo's own bucket units line up 1:1 with ours, so $dateTrunc takes the key directly. */
const MONGO_BUCKET_UNITS = new Set<TimeBucket>(["day", "week", "month", "quarter", "year"]);

/** Chart row caps. A grouped summary or scatter can carry more points than a categorical bar chart; a raw-row table passes FALLBACK_LIMIT explicitly, since dumping 500 unaggregated rows into a dashboard card helps nobody. */
const DEFAULT_LIMIT: Record<string, number> = { table: 500, pivot: 500, scatter: 500 };
const FALLBACK_LIMIT = 50;
const MAX_LIMIT = 1000;

function resolveLimit(widget: Widget, fallbackOverride?: number): number {
    const fallback = fallbackOverride ?? DEFAULT_LIMIT[widget.chartType] ?? FALLBACK_LIMIT;
    if (!Number.isFinite(widget.limit)) return fallback;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(widget.limit!)));
}

/**
 * Default ordering. A bucketed time series read newest-value-first is
 * nonsense — it has to run along the axis — so it sorts by label ascending,
 * while a categorical breakdown stays a top-N by value.
 */
function resolveSort(widget: Widget): { by: "value" | "label"; dir: "asc" | "desc" } {
    const by = widget.sortBy ?? (widget.xBucket || chartShapeOf(widget.chartType) === "table" ? "label" : "value");
    return { by, dir: widget.sortDir ?? (by === "label" ? "asc" : "desc") };
}

/** Operators that compare against a bound value; the rest take none (null checks) or a list (`in`). */
const VALUE_OPS = new Set<FilterOperator>(["=", "!=", ">", ">=", "<", "<=", "like"]);

function inList(value: string): string[] {
    return value.split(",").map((v) => v.trim()).filter((v) => v !== "");
}

/** Matches a whole filter value of the form `{{param_name}}` — a dashboard-parameter placeholder, not a literal. */
const PLACEHOLDER_RE = /^\{\{(\w+)\}\}$/;

/**
 * Resolves a filter's value against dashboard/embed params: a literal value
 * passes through unchanged, a `{{name}}` placeholder is looked up in
 * `dashboardParams`.
 *
 * Returns `undefined` when a placeholder's param was not supplied — the
 * caller then drops that filter entirely (treated as "no constraint"). This
 * is the simpler and safer of the two options the plan allows: a
 * not-yet-chosen filter-bar value is the normal state (e.g. before a viewer
 * picks one), not an error condition, and "no constraint" can never produce
 * an unintentionally *narrower* or wrong result — only a broader one, same
 * as the filter not existing at all.
 */
function resolveFilterValue(filter: WidgetFilter, dashboardParams: Record<string, unknown>): string | undefined {
    const name = PLACEHOLDER_RE.exec(filter.value)?.[1];
    if (!name) return filter.value;
    const value = dashboardParams[name];
    if (value === undefined || value === null || value === "") return undefined;
    return String(value);
}

/**
 * Builds the WHERE clause for a widget's filters.
 *
 * Operator keys come from a closed set (validated on write in
 * widget-validation, re-checked here because widgets.json predates that
 * validation) and column names are allowlisted against the live schema by
 * the caller, so the only thing that varies freely is the value — and that
 * is always bound, never concatenated, except on ClickHouse where this
 * driver's HTTP call has no binder and values go through chLiteral.
 *
 * `dashboardParams` resolves any `{{param_name}}` filter value (see
 * resolveFilterValue); a widget with no such placeholders ignores it
 * entirely and behaves exactly as before.
 */
function buildWhere(
    driver: string,
    filters: WidgetFilter[],
    params: unknown[],
    dashboardParams: Record<string, unknown> = {}
): string {
    const clauses: string[] = [];
    const bind = (value: unknown): string => {
        if (driver === "clickhouse") return chLiteral(value);
        params.push(value);
        return placeholder(driver, params.length);
    };

    for (const f of filters) {
        const op = f.op ?? "=";
        if (!VALUE_OPS.has(op) && op !== "in" && op !== "is null" && op !== "is not null") {
            throw new Error(`Unsupported filter operator: ${JSON.stringify(op)}`);
        }
        const col = quoteIdent(driver, f.column);
        if (op === "is null") { clauses.push(`${col} IS NULL`); continue; }
        if (op === "is not null") { clauses.push(`${col} IS NOT NULL`); continue; }

        const value = resolveFilterValue(f, dashboardParams);
        if (value === undefined) continue; // unset dashboard param — filter dropped, see resolveFilterValue

        if (op === "in") {
            const values = inList(value);
            if (values.length === 0) throw new Error(`Filter on "${f.column}" uses "in" but lists no values`);
            clauses.push(`${col} IN (${values.map(bind).join(", ")})`);
        } else {
            clauses.push(`${col} ${op.toUpperCase()} ${bind(value)}`);
        }
    }
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

/**
 * The same filters as a Mongo `$match`. Kept beside buildWhere so the two
 * can't drift apart. `dashboardParams` resolves `{{param_name}}` values the
 * same way buildWhere does (see resolveFilterValue).
 */
function buildMatch(filters: WidgetFilter[], dashboardParams: Record<string, unknown> = {}): Record<string, unknown> {
    const MONGO_OPS: Partial<Record<FilterOperator, string>> = {
        "!=": "$ne", ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte",
    };
    const match: Record<string, unknown> = {};
    for (const f of filters) {
        const op = f.op ?? "=";
        if (op === "is null") { match[f.column] = null; continue; }
        if (op === "is not null") { match[f.column] = { $ne: null }; continue; }

        const value = resolveFilterValue(f, dashboardParams);
        if (value === undefined) continue; // unset dashboard param — filter dropped, see resolveFilterValue

        if (op === "=") match[f.column] = value;
        else if (op === "in") {
            const values = inList(value);
            if (values.length === 0) throw new Error(`Filter on "${f.column}" uses "in" but lists no values`);
            match[f.column] = { $in: values };
        } else if (op === "like") {
            // SQL's % wildcard translated to a regex, with everything else escaped so a
            // filter value can't smuggle in a pattern of its own.
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
            match[f.column] = { $regex: `^${escaped}$`, $options: "i" };
        } else if (MONGO_OPS[op]) {
            match[f.column] = { [MONGO_OPS[op]!]: value };
        } else {
            throw new Error(`Unsupported filter operator: ${JSON.stringify(op)}`);
        }
    }
    return match;
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
    /** Set only for a "table" widget with both xField and xField2 — signals a row × column pivot, keyed by this field, rather than a flat grouped list. */
    x2Key?: string;
}

/**
 * Builds and runs the SQL for a widget's chart, validating every column
 * name the widget references against the table's real, driver-reported
 * schema first. SQL has no parameterized-identifier syntax (only values
 * can be bound with $1/?), so this allowlist check is what stands in for
 * that — a widget can only ever reference a table/column that genuinely
 * exists, never arbitrary interpolated text.
 */
async function runWidgetQuery(
    conn: DriverConnection,
    config: ConnectionConfig,
    widget: Widget,
    dashboardParams: Record<string, unknown>
): Promise<WidgetData> {
    if (widget.kind === "text") throw new Error("Text widgets have no data to query");
    if (config.driver === "mongodb") return fetchMongoWidgetData(conn, widget, dashboardParams);
    if (config.driver === "redis") return fetchRedisWidgetData(conn, widget);
    if (!SQL_DRIVERS.has(config.driver)) {
        throw new Error(`Dashboard charts aren't supported for ${config.driver} yet.`);
    }
    const driver = config.driver;
    assertQueryableWidget(widget);

    const tables = await conn.listTables(widget.schema);
    const tableDef = tables.find((t) => t.name === widget.table);
    if (!tableDef) throw new Error(`Table "${widget.table}" not found`);
    const validColumns = new Set(tableDef.columns.map((c) => c.name));

    for (const field of [widget.xField, widget.xField2, widget.yField, ...(widget.filters ?? []).map((f) => f.column)]) {
        if (field && !validColumns.has(field)) throw new Error(`Column "${field}" does not exist on ${widget.table}`);
    }

    const schemaPrefix = widget.schema ? `${quoteIdent(driver, widget.schema)}.` : "";
    const tableRef = `${schemaPrefix}${quoteIdent(driver, widget.table)}`;

    const params: unknown[] = [];
    const whereSql = buildWhere(driver, widget.filters ?? [], params, dashboardParams);
    const limit = resolveLimit(widget);
    const { by: sortBy, dir: sortDir } = resolveSort(widget);
    const sortSql = sortDir === "asc" ? "ASC" : "DESC";

    /** The x-axis expression — the bare column, or a calendar bucket over it. */
    const xExpr = (ident: string): string => {
        if (!widget.xBucket) return ident;
        const bucket = BUCKET_SQL[driver]?.[widget.xBucket];
        if (!bucket) throw new Error(`Time bucketing isn't supported for ${driver}`);
        return bucket(ident);
    };

    const yExpr =
        widget.aggregation === "count"
            ? "COUNT(*)"
            : `${widget.aggregation.toUpperCase()}(${quoteIdent(driver, widget.yField!)})`;

    // A chart type shaped "table" (registered in chart-shapes.ts — "pivot" is
    // one such type, added purely through the web-side chart-type registry in
    // chartTypes.ts) is data-identical to "table"'s row × column grouping —
    // it's a distinct author-facing chart type, not a distinct query shape.
    if (chartShapeOf(widget.chartType) === "table") {
        if (!widget.xField) {
            const rows = await collectRows(conn, { language: "sql", sql: `SELECT * FROM ${tableRef} ${whereSql} LIMIT ${resolveLimit(widget, FALLBACK_LIMIT)}`, params });
            return { rows, xKey: "", yKey: "" };
        }
        // Grouped summary (Salesforce-style row grouping), or a row × column pivot when xField2 is also set.
        const xIdent = xExpr(quoteIdent(driver, widget.xField));
        const groupCols = [xIdent];
        const selectCols = [`${xIdent} AS x`];
        if (widget.xField2) {
            const x2Ident = quoteIdent(driver, widget.xField2);
            groupCols.push(x2Ident);
            selectCols.push(`${x2Ident} AS x2`);
        }
        const orderSql = sortBy === "value" ? `y ${sortSql}` : groupCols.map((c) => `${c} ${sortSql}`).join(", ");
        const sql = `SELECT ${selectCols.join(", ")}, ${yExpr} AS y FROM ${tableRef} ${whereSql} GROUP BY ${groupCols.join(", ")} ORDER BY ${orderSql} LIMIT ${limit}`;
        const rows = await collectRows(conn, { language: "sql", sql, params });
        return { rows, xKey: "x", yKey: "y", x2Key: widget.xField2 ? "x2" : undefined };
    }

    if (chartShapeOf(widget.chartType) === "number") {
        const rows = await collectRows(conn, { language: "sql", sql: `SELECT ${yExpr} AS y FROM ${tableRef} ${whereSql}`, params });
        return { rows, xKey: "", yKey: "y" };
    }

    if (chartShapeOf(widget.chartType) === "raw") {
        // Raw (x, y) pairs, not aggregated — unlike bar/line/area, a scatter plot shows every row.
        if (!widget.xField || !widget.yField) throw new Error("Scatter charts need both an x and y column");
        const sql = `SELECT ${quoteIdent(driver, widget.xField)} AS x, ${quoteIdent(driver, widget.yField)} AS y FROM ${tableRef} ${whereSql} LIMIT ${limit}`;
        const rows = await collectRows(conn, { language: "sql", sql, params });
        return { rows, xKey: "x", yKey: "y" };
    }

    // bar / line / area / pie — grouped aggregation
    if (!widget.xField) throw new Error(`${widget.chartType} charts need an x-axis column`);
    const xIdent = xExpr(quoteIdent(driver, widget.xField));
    const orderSql = sortBy === "value" ? `y ${sortSql}` : `${xIdent} ${sortSql}`;
    const sql = `SELECT ${xIdent} AS x, ${yExpr} AS y FROM ${tableRef} ${whereSql} GROUP BY ${xIdent} ORDER BY ${orderSql} LIMIT ${limit}`;
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
async function fetchMongoWidgetData(
    conn: DriverConnection,
    widget: Widget,
    dashboardParams: Record<string, unknown>
): Promise<WidgetData> {
    // `aggregation` becomes a `$sum`/`$avg`/... accumulator key below, so it
    // needs the same closed-set check the SQL path gets.
    if (!SQL_AGGREGATIONS.has(widget.aggregation)) {
        throw new Error(`Unsupported aggregation: ${JSON.stringify(widget.aggregation)}`);
    }
    const collections = await conn.listTables();
    const collDef = collections.find((c) => c.name === widget.table);
    if (!collDef) throw new Error(`Collection "${widget.table}" not found`);
    const validFields = new Set(collDef.columns.map((c) => c.name));

    for (const field of [widget.xField, widget.xField2, widget.yField, ...(widget.filters ?? []).map((f) => f.column)]) {
        if (field && !validFields.has(field)) throw new Error(`Field "${field}" does not exist on ${widget.table}`);
    }

    const match = buildMatch(widget.filters ?? [], dashboardParams);
    const limit = resolveLimit(widget);
    const { by: sortBy, dir: sortDir } = resolveSort(widget);
    const sortSign = sortDir === "asc" ? 1 : -1;

    const accumulator =
        widget.aggregation === "count" ? { $sum: 1 } : { [`$${widget.aggregation}`]: `$${widget.yField}` };

    /** The group key — the bare field, or a $dateTrunc bucket over it. */
    const xValue = (field: string): unknown => {
        if (!widget.xBucket) return `$${field}`;
        if (!MONGO_BUCKET_UNITS.has(widget.xBucket)) throw new Error(`Unsupported bucket: ${widget.xBucket}`);
        return { $dateTrunc: { date: `$${field}`, unit: widget.xBucket } };
    };

    const pipeline: Record<string, unknown>[] = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });

    if (chartShapeOf(widget.chartType) === "table") {
        if (!widget.xField) {
            const rows = await collectRows(conn, { language: "mongo", collection: widget.table, filter: match, limit: resolveLimit(widget, FALLBACK_LIMIT) });
            return { rows, xKey: "", yKey: "" };
        }
        // Grouped summary, or a row × column pivot when xField2 is also set — same shape the SQL path produces.
        const groupId: Record<string, unknown> = { x: xValue(widget.xField) };
        if (widget.xField2) groupId.x2 = `$${widget.xField2}`;
        pipeline.push({ $group: { _id: groupId, y: accumulator } });
        pipeline.push({ $sort: sortBy === "value" ? { y: sortSign } : { "_id.x": sortSign, "_id.x2": sortSign } });
        pipeline.push({ $limit: limit });
        pipeline.push({ $project: { x: "$_id.x", ...(widget.xField2 ? { x2: "$_id.x2" } : {}), y: 1, _id: 0 } });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "x", yKey: "y", x2Key: widget.xField2 ? "x2" : undefined };
    }

    if (chartShapeOf(widget.chartType) === "number") {
        pipeline.push({ $group: { _id: null, y: accumulator } });
        pipeline.push({ $project: { _id: 0, y: 1 } });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "", yKey: "y" };
    }

    if (chartShapeOf(widget.chartType) === "raw") {
        // Raw (x, y) pairs, not aggregated — unlike bar/line/area, a scatter plot shows every document.
        if (!widget.xField || !widget.yField) throw new Error("Scatter charts need both an x and y column");
        pipeline.push({ $project: { x: `$${widget.xField}`, y: `$${widget.yField}`, _id: 0 } });
        pipeline.push({ $limit: limit });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "x", yKey: "y" };
    }

    // bar / line / area / pie — grouped aggregation
    if (!widget.xField) throw new Error(`${widget.chartType} charts need an x-axis column`);
    pipeline.push({ $group: { _id: xValue(widget.xField), y: accumulator } });
    pipeline.push({ $sort: sortBy === "value" ? { y: sortSign } : { _id: sortSign } });
    pipeline.push({ $limit: limit });
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
    const shape = chartShapeOf(widget.chartType);
    if (shape === "table") {
        const page = await conn.queryRows({ table: widget.table, pageSize: resolveLimit(widget, FALLBACK_LIMIT), afterCursor: null });
        return { rows: page.rows, xKey: "", yKey: "" };
    }
    if (shape === "number") {
        const count = await conn.countRowsExact(widget.table);
        return { rows: [{ y: count.value }], xKey: "", yKey: "y" };
    }
    throw new Error(`Redis widgets only support "number"/"table"-shaped chart types — there's no field to group ${widget.chartType} charts by across keys.`);
}

/**
 * Short-lived cache in front of every widget query.
 *
 * A widget's query is a full aggregate over its table — on a large table
 * that is the single most expensive thing this server does, and it was being
 * run once per requester. A dashboard with 12 widgets open in three tabs
 * plus a public embed was 48 concurrent full scans of the same data, all
 * answering the same question.
 *
 * MetadataCache caches the *promise*, so the dominant win here isn't the TTL
 * — it's that concurrent callers for the same widget share one round-trip
 * instead of each starting their own. The TTL is deliberately short: widgets
 * are refetched on realtime table changes (see WidgetCard), and a stale chart
 * is worse than a slightly repeated query.
 */
const WIDGET_DATA_TTL_MS = 5_000;
const widgetDataCache = new MetadataCache(WIDGET_DATA_TTL_MS);

/**
 * Runs a widget's query, coalescing concurrent and near-repeat requests.
 *
 * Keyed on the widget's full definition rather than its id, so editing a
 * widget takes effect immediately instead of after the TTL — and on the
 * connection id, so two widgets that differ only by connection never share
 * a result. `dashboardParams` (dashboard filter-bar / embed values, resolved
 * into any `{{param_name}}` filter — see resolveFilterValue) is folded into
 * the same key, so two viewers with different filter selections never share
 * a cached result; a widget with no placeholders is called with `{}` here
 * and produces the exact same key/query as before this feature existed.
 */
export function fetchWidgetData(
    conn: DriverConnection,
    config: ConnectionConfig,
    widget: Widget,
    dashboardParams: Record<string, unknown> = {}
): Promise<WidgetData> {
    const key = `${conn.id}:${JSON.stringify(widget)}:${JSON.stringify(dashboardParams)}`;
    return widgetDataCache.get(key, () => runWidgetQuery(conn, config, widget, dashboardParams));
}
