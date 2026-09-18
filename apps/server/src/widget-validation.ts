import { assertSafeIdentifier } from "@pilaniaanand/driver-interface";
import type {
    Aggregation,
    ChartType,
    FilterOperator,
    HighlightOperator,
    HighlightRule,
    TimeBucket,
    Widget,
    WidgetFilter,
} from "./models.js";

/**
 * Runtime validation for widget input.
 *
 * The routes used to cast `req.body` straight to `Widget` and store it. The
 * TypeScript types are erased at runtime, so nothing checked these fields —
 * and `chart-query.ts` interpolates two of them directly into SQL:
 * `aggregation` (as `${agg.toUpperCase()}(col)`) and `schema` (through
 * quoteIdent, which quotes but does not escape). Column and table names were
 * already allowlisted against the live schema; these two were not, which made
 * a saved widget an arbitrary-SQL vehicle.
 *
 * Everything that reaches SQL is checked against a closed set here, so
 * chart-query only ever concatenates values this module has approved.
 */
const CHART_TYPES = new Set<ChartType>(["bar", "line", "area", "scatter", "pie", "number", "table"]);
const AGGREGATIONS = new Set<Aggregation>(["count", "sum", "avg", "min", "max"]);
const HIGHLIGHT_OPS = new Set<HighlightOperator>(["gt", "gte", "lt", "lte", "eq"]);
/** Filter operators become SQL text in chart-query, so they are a closed set here too. */
const FILTER_OPS = new Set<FilterOperator>(["=", "!=", ">", ">=", "<", "<=", "like", "in", "is null", "is not null"]);
const TIME_BUCKETS = new Set<TimeBucket>(["day", "week", "month", "quarter", "year"]);
/** Matches chart-query's MAX_LIMIT — a widget asking for more rows than a chart can render is a mistake, not a feature. */
const MAX_LIMIT = 1000;

/** Blocks `expression(...)` / `url(...)` / escapes in a CSS color that lands in a style attribute. */
const SAFE_CSS_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;

function str(value: unknown, field: string, { required = false } = {}): string | undefined {
    if (value === undefined || value === null || value === "") {
        if (required) throw new Error(`${field} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Error(`${field} must be a string`);
    return value;
}

function validateHighlightRules(raw: unknown): HighlightRule[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw new Error("highlightRules must be an array");
    return raw.map((r, i) => {
        const rule = r as Record<string, unknown>;
        const operator = rule.operator as HighlightOperator;
        if (!HIGHLIGHT_OPS.has(operator)) {
            throw new Error(`highlightRules[${i}].operator must be one of: ${[...HIGHLIGHT_OPS].join(", ")}`);
        }
        if (typeof rule.value !== "number" || !Number.isFinite(rule.value)) {
            throw new Error(`highlightRules[${i}].value must be a finite number`);
        }
        const color = str(rule.color, `highlightRules[${i}].color`, { required: true })!;
        if (!SAFE_CSS_COLOR.test(color)) throw new Error(`highlightRules[${i}].color is not a valid CSS color`);
        const column = str(rule.column, `highlightRules[${i}].column`);
        if (column !== undefined) assertSafeIdentifier(column, "highlight column");
        return { column, operator, value: rule.value, color };
    });
}

export type WidgetInput = Omit<Widget, "id" | "createdAt">;

export function validateWidgetInput(raw: unknown): WidgetInput {
    if (!raw || typeof raw !== "object") throw new Error("Request body must be a widget object");
    const body = raw as Record<string, unknown>;

    const chartType = body.chartType as ChartType;
    if (!CHART_TYPES.has(chartType)) throw new Error(`chartType must be one of: ${[...CHART_TYPES].join(", ")}`);

    const aggregation = body.aggregation as Aggregation;
    if (!AGGREGATIONS.has(aggregation)) throw new Error(`aggregation must be one of: ${[...AGGREGATIONS].join(", ")}`);

    const table = str(body.table, "table", { required: true })!;
    assertSafeIdentifier(table, "table");

    const schema = str(body.schema, "schema");
    if (schema !== undefined) assertSafeIdentifier(schema, "schema");

    // Column names are re-checked against the live schema in chart-query, but
    // the charset check has to happen before they are ever stored.
    const fields: Record<"xField" | "xField2" | "yField", string | undefined> = {
        xField: str(body.xField, "xField"),
        xField2: str(body.xField2, "xField2"),
        yField: str(body.yField, "yField"),
    };
    for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined) assertSafeIdentifier(value, name);
    }

    if (aggregation !== "count" && chartType !== "table" && !fields.yField) {
        throw new Error(`aggregation "${aggregation}" needs a yField`);
    }

    let filters: WidgetFilter[] | undefined;
    if (body.filters !== undefined && body.filters !== null) {
        if (!Array.isArray(body.filters)) throw new Error("filters must be an array");
        filters = body.filters.map((f, i) => {
            const filter = f as Record<string, unknown>;
            const column = str(filter.column, `filters[${i}].column`, { required: true })!;
            assertSafeIdentifier(column, "filter column");

            const op = (filter.op ?? "=") as FilterOperator;
            if (!FILTER_OPS.has(op)) throw new Error(`filters[${i}].op must be one of: ${[...FILTER_OPS].join(", ")}`);
            // Null checks compare against nothing, so they carry no value at all.
            if (op === "is null" || op === "is not null") return { column, op, value: "" };

            // Values are bound as parameters (or escaped as literals for
            // ClickHouse), so any string is fine — but it must be a string,
            // not an object that would confuse the driver's binder.
            const value = filter.value;
            if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
                throw new Error(`filters[${i}].value must be a string, number, or boolean`);
            }
            return { column, op, value: String(value) };
        });
    }

    const xBucket =
        body.xBucket === undefined || body.xBucket === null || body.xBucket === "" ? undefined : (body.xBucket as TimeBucket);
    if (xBucket !== undefined && !TIME_BUCKETS.has(xBucket)) {
        throw new Error(`xBucket must be one of: ${[...TIME_BUCKETS].join(", ")}`);
    }

    // Interpolated straight into `LIMIT n`, so it has to be a real integer and nothing else.
    let limit: number | undefined;
    if (body.limit !== undefined && body.limit !== null && body.limit !== "") {
        const n = Number(body.limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
            throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
        }
        limit = n;
    }

    const sortBy = str(body.sortBy, "sortBy") as Widget["sortBy"];
    if (sortBy !== undefined && sortBy !== "value" && sortBy !== "label") throw new Error('sortBy must be "value" or "label"');
    const sortDir = str(body.sortDir, "sortDir") as Widget["sortDir"];
    if (sortDir !== undefined && sortDir !== "asc" && sortDir !== "desc") throw new Error('sortDir must be "asc" or "desc"');

    return {
        title: str(body.title, "title", { required: true })!.slice(0, 200),
        connectionId: str(body.connectionId, "connectionId", { required: true })!,
        schema,
        table,
        chartType,
        ...fields,
        aggregation,
        filters,
        xBucket,
        limit,
        sortBy,
        sortDir,
        highlightRules: validateHighlightRules(body.highlightRules),
    };
}

export function validateWidgetPatch(existing: Widget, patch: unknown): WidgetInput {
    if (!patch || typeof patch !== "object") throw new Error("Request body must be a widget patch object");
    const { id: _id, createdAt: _createdAt, ...rest } = { ...existing, ...(patch as Record<string, unknown>) };
    return validateWidgetInput(rest);
}
