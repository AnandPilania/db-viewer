import { assertSafeIdentifier, MetadataCache } from "@pilaniaanand/driver-interface";
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
function assertQueryableWidget(widget) {
    if (!SQL_AGGREGATIONS.has(widget.aggregation)) {
        throw new Error(`Unsupported aggregation: ${JSON.stringify(widget.aggregation)}`);
    }
    if (widget.schema !== undefined)
        assertSafeIdentifier(widget.schema, "schema");
    assertSafeIdentifier(widget.table, "table");
}
/** SQL-family drivers build a validated SQL string; MongoDB and Redis build their own native query shapes instead (see fetchMongoWidgetData / fetchRedisWidgetData). ClickHouse is SQL too, but its driver's streamQuery doesn't bind params (see chLiteral below), so it gets literal-embedded values instead of placeholders. */
const SQL_DRIVERS = new Set(["postgres", "mysql", "sqlite", "clickhouse"]);
function quoteIdent(driver, ident) {
    return driver === "mysql" || driver === "clickhouse" ? `\`${ident}\`` : `"${ident}"`;
}
function placeholder(driver, index) {
    return driver === "postgres" ? `$${index}` : "?";
}
/** ClickHouse's HTTP interface, as this driver calls it, takes a single SQL string with no separate parameter binding — so filter values are embedded as escaped literals instead of `$1`/`?` placeholders. */
function chLiteral(value) {
    if (value === null || value === undefined)
        return "NULL";
    if (typeof value === "number")
        return String(value);
    if (typeof value === "boolean")
        return value ? "1" : "0";
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
const BUCKET_SQL = {
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
const MONGO_BUCKET_UNITS = new Set(["day", "week", "month", "quarter", "year"]);
/** Chart row caps. A grouped summary or scatter can carry more points than a categorical bar chart; a raw-row table passes FALLBACK_LIMIT explicitly, since dumping 500 unaggregated rows into a dashboard card helps nobody. */
const DEFAULT_LIMIT = { table: 500, scatter: 500 };
const FALLBACK_LIMIT = 50;
const MAX_LIMIT = 1000;
function resolveLimit(widget, fallbackOverride) {
    const fallback = fallbackOverride ?? DEFAULT_LIMIT[widget.chartType] ?? FALLBACK_LIMIT;
    if (!Number.isFinite(widget.limit))
        return fallback;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(widget.limit)));
}
/**
 * Default ordering. A bucketed time series read newest-value-first is
 * nonsense — it has to run along the axis — so it sorts by label ascending,
 * while a categorical breakdown stays a top-N by value.
 */
function resolveSort(widget) {
    const by = widget.sortBy ?? (widget.xBucket || widget.chartType === "table" ? "label" : "value");
    return { by, dir: widget.sortDir ?? (by === "label" ? "asc" : "desc") };
}
/** Operators that compare against a bound value; the rest take none (null checks) or a list (`in`). */
const VALUE_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "like"]);
function inList(value) {
    return value.split(",").map((v) => v.trim()).filter((v) => v !== "");
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
 */
function buildWhere(driver, filters, params) {
    const clauses = [];
    const bind = (value) => {
        if (driver === "clickhouse")
            return chLiteral(value);
        params.push(value);
        return placeholder(driver, params.length);
    };
    for (const f of filters) {
        const op = f.op ?? "=";
        if (!VALUE_OPS.has(op) && op !== "in" && op !== "is null" && op !== "is not null") {
            throw new Error(`Unsupported filter operator: ${JSON.stringify(op)}`);
        }
        const col = quoteIdent(driver, f.column);
        if (op === "is null")
            clauses.push(`${col} IS NULL`);
        else if (op === "is not null")
            clauses.push(`${col} IS NOT NULL`);
        else if (op === "in") {
            const values = inList(f.value);
            if (values.length === 0)
                throw new Error(`Filter on "${f.column}" uses "in" but lists no values`);
            clauses.push(`${col} IN (${values.map(bind).join(", ")})`);
        }
        else {
            clauses.push(`${col} ${op.toUpperCase()} ${bind(f.value)}`);
        }
    }
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}
/** The same filters as a Mongo `$match`. Kept beside buildWhere so the two can't drift apart. */
function buildMatch(filters) {
    const MONGO_OPS = {
        "!=": "$ne", ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte",
    };
    const match = {};
    for (const f of filters) {
        const op = f.op ?? "=";
        if (op === "=")
            match[f.column] = f.value;
        else if (op === "is null")
            match[f.column] = null;
        else if (op === "is not null")
            match[f.column] = { $ne: null };
        else if (op === "in") {
            const values = inList(f.value);
            if (values.length === 0)
                throw new Error(`Filter on "${f.column}" uses "in" but lists no values`);
            match[f.column] = { $in: values };
        }
        else if (op === "like") {
            // SQL's % wildcard translated to a regex, with everything else escaped so a
            // filter value can't smuggle in a pattern of its own.
            const escaped = f.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
            match[f.column] = { $regex: `^${escaped}$`, $options: "i" };
        }
        else if (MONGO_OPS[op]) {
            match[f.column] = { [MONGO_OPS[op]]: f.value };
        }
        else {
            throw new Error(`Unsupported filter operator: ${JSON.stringify(op)}`);
        }
    }
    return match;
}
async function collectRows(conn, query) {
    const rows = [];
    for await (const chunk of conn.streamQuery({ query })) {
        rows.push(...chunk.rows);
    }
    return rows;
}
/**
 * Builds and runs the SQL for a widget's chart, validating every column
 * name the widget references against the table's real, driver-reported
 * schema first. SQL has no parameterized-identifier syntax (only values
 * can be bound with $1/?), so this allowlist check is what stands in for
 * that — a widget can only ever reference a table/column that genuinely
 * exists, never arbitrary interpolated text.
 */
async function runWidgetQuery(conn, config, widget) {
    if (config.driver === "mongodb")
        return fetchMongoWidgetData(conn, widget);
    if (config.driver === "redis")
        return fetchRedisWidgetData(conn, widget);
    if (!SQL_DRIVERS.has(config.driver)) {
        throw new Error(`Dashboard charts aren't supported for ${config.driver} yet.`);
    }
    const driver = config.driver;
    assertQueryableWidget(widget);
    const tables = await conn.listTables(widget.schema);
    const tableDef = tables.find((t) => t.name === widget.table);
    if (!tableDef)
        throw new Error(`Table "${widget.table}" not found`);
    const validColumns = new Set(tableDef.columns.map((c) => c.name));
    for (const field of [widget.xField, widget.xField2, widget.yField, ...(widget.filters ?? []).map((f) => f.column)]) {
        if (field && !validColumns.has(field))
            throw new Error(`Column "${field}" does not exist on ${widget.table}`);
    }
    const schemaPrefix = widget.schema ? `${quoteIdent(driver, widget.schema)}.` : "";
    const tableRef = `${schemaPrefix}${quoteIdent(driver, widget.table)}`;
    const params = [];
    const whereSql = buildWhere(driver, widget.filters ?? [], params);
    const limit = resolveLimit(widget);
    const { by: sortBy, dir: sortDir } = resolveSort(widget);
    const sortSql = sortDir === "asc" ? "ASC" : "DESC";
    /** The x-axis expression — the bare column, or a calendar bucket over it. */
    const xExpr = (ident) => {
        if (!widget.xBucket)
            return ident;
        const bucket = BUCKET_SQL[driver]?.[widget.xBucket];
        if (!bucket)
            throw new Error(`Time bucketing isn't supported for ${driver}`);
        return bucket(ident);
    };
    const yExpr = widget.aggregation === "count"
        ? "COUNT(*)"
        : `${widget.aggregation.toUpperCase()}(${quoteIdent(driver, widget.yField)})`;
    if (widget.chartType === "table") {
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
    if (widget.chartType === "number") {
        const rows = await collectRows(conn, { language: "sql", sql: `SELECT ${yExpr} AS y FROM ${tableRef} ${whereSql}`, params });
        return { rows, xKey: "", yKey: "y" };
    }
    if (widget.chartType === "scatter") {
        // Raw (x, y) pairs, not aggregated — unlike bar/line/area, a scatter plot shows every row.
        if (!widget.xField || !widget.yField)
            throw new Error("Scatter charts need both an x and y column");
        const sql = `SELECT ${quoteIdent(driver, widget.xField)} AS x, ${quoteIdent(driver, widget.yField)} AS y FROM ${tableRef} ${whereSql} LIMIT ${limit}`;
        const rows = await collectRows(conn, { language: "sql", sql, params });
        return { rows, xKey: "x", yKey: "y" };
    }
    // bar / line / area / pie — grouped aggregation
    if (!widget.xField)
        throw new Error(`${widget.chartType} charts need an x-axis column`);
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
async function fetchMongoWidgetData(conn, widget) {
    // `aggregation` becomes a `$sum`/`$avg`/... accumulator key below, so it
    // needs the same closed-set check the SQL path gets.
    if (!SQL_AGGREGATIONS.has(widget.aggregation)) {
        throw new Error(`Unsupported aggregation: ${JSON.stringify(widget.aggregation)}`);
    }
    const collections = await conn.listTables();
    const collDef = collections.find((c) => c.name === widget.table);
    if (!collDef)
        throw new Error(`Collection "${widget.table}" not found`);
    const validFields = new Set(collDef.columns.map((c) => c.name));
    for (const field of [widget.xField, widget.xField2, widget.yField, ...(widget.filters ?? []).map((f) => f.column)]) {
        if (field && !validFields.has(field))
            throw new Error(`Field "${field}" does not exist on ${widget.table}`);
    }
    const match = buildMatch(widget.filters ?? []);
    const limit = resolveLimit(widget);
    const { by: sortBy, dir: sortDir } = resolveSort(widget);
    const sortSign = sortDir === "asc" ? 1 : -1;
    const accumulator = widget.aggregation === "count" ? { $sum: 1 } : { [`$${widget.aggregation}`]: `$${widget.yField}` };
    /** The group key — the bare field, or a $dateTrunc bucket over it. */
    const xValue = (field) => {
        if (!widget.xBucket)
            return `$${field}`;
        if (!MONGO_BUCKET_UNITS.has(widget.xBucket))
            throw new Error(`Unsupported bucket: ${widget.xBucket}`);
        return { $dateTrunc: { date: `$${field}`, unit: widget.xBucket } };
    };
    const pipeline = [];
    if (Object.keys(match).length)
        pipeline.push({ $match: match });
    if (widget.chartType === "table") {
        if (!widget.xField) {
            const rows = await collectRows(conn, { language: "mongo", collection: widget.table, filter: match, limit: resolveLimit(widget, FALLBACK_LIMIT) });
            return { rows, xKey: "", yKey: "" };
        }
        // Grouped summary, or a row × column pivot when xField2 is also set — same shape the SQL path produces.
        const groupId = { x: xValue(widget.xField) };
        if (widget.xField2)
            groupId.x2 = `$${widget.xField2}`;
        pipeline.push({ $group: { _id: groupId, y: accumulator } });
        pipeline.push({ $sort: sortBy === "value" ? { y: sortSign } : { "_id.x": sortSign, "_id.x2": sortSign } });
        pipeline.push({ $limit: limit });
        pipeline.push({ $project: { x: "$_id.x", ...(widget.xField2 ? { x2: "$_id.x2" } : {}), y: 1, _id: 0 } });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "x", yKey: "y", x2Key: widget.xField2 ? "x2" : undefined };
    }
    if (widget.chartType === "number") {
        pipeline.push({ $group: { _id: null, y: accumulator } });
        pipeline.push({ $project: { _id: 0, y: 1 } });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "", yKey: "y" };
    }
    if (widget.chartType === "scatter") {
        // Raw (x, y) pairs, not aggregated — unlike bar/line/area, a scatter plot shows every document.
        if (!widget.xField || !widget.yField)
            throw new Error("Scatter charts need both an x and y column");
        pipeline.push({ $project: { x: `$${widget.xField}`, y: `$${widget.yField}`, _id: 0 } });
        pipeline.push({ $limit: limit });
        const rows = await collectRows(conn, { language: "mongo", collection: widget.table, pipeline });
        return { rows, xKey: "x", yKey: "y" };
    }
    // bar / line / area / pie — grouped aggregation
    if (!widget.xField)
        throw new Error(`${widget.chartType} charts need an x-axis column`);
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
async function fetchRedisWidgetData(conn, widget) {
    if (widget.chartType === "table") {
        const page = await conn.queryRows({ table: widget.table, pageSize: resolveLimit(widget, FALLBACK_LIMIT), afterCursor: null });
        return { rows: page.rows, xKey: "", yKey: "" };
    }
    if (widget.chartType === "number") {
        const count = await conn.countRowsExact(widget.table);
        return { rows: [{ y: count.value }], xKey: "", yKey: "y" };
    }
    throw new Error(`Redis widgets only support "number" and "table" chart types — there's no field to group ${widget.chartType} charts by across keys.`);
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
 * a result.
 */
export function fetchWidgetData(conn, config, widget) {
    const key = `${conn.id}:${JSON.stringify(widget)}`;
    return widgetDataCache.get(key, () => runWidgetQuery(conn, config, widget));
}
//# sourceMappingURL=chart-query.js.map