export type ChartType = "bar" | "line" | "area" | "scatter" | "pie" | "number" | "table";
export type Aggregation = "count" | "sum" | "avg" | "min" | "max";
export type HighlightOperator = "gt" | "gte" | "lt" | "lte" | "eq";
/** Filter comparison. Every one of these is a closed-set key, never user text — see chart-query's operator tables. */
export type FilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "in" | "is null" | "is not null";
/** Calendar bucket for a date/datetime x-axis, so a time series groups by period instead of by exact timestamp. */
export type TimeBucket = "day" | "week" | "month" | "quarter" | "year";
export interface WidgetFilter {
    column: string;
    /** Defaults to "=" when absent — widgets stored before operators existed. */
    op?: FilterOperator;
    /** Comma-separated for "in"; ignored for "is null"/"is not null". */
    value: string;
}
export interface HighlightRule {
    /** Cell/value key to test — "y" for any aggregated value, or a raw column name for an ungrouped table. Omit to match the widget's primary value wherever it appears. */
    column?: string;
    operator: HighlightOperator;
    value: number;
    /** CSS color applied to the cell background. First matching rule wins. */
    color: string;
}
export interface Widget {
    id: string;
    title: string;
    connectionId: string;
    schema?: string;
    table: string;
    chartType: ChartType;
    /** Column to group by (bar/line/area/pie), the row-grouping column for a "table" widget (turns raw rows into a grouped summary), or the raw x-value column for "scatter" (no grouping/aggregation there). */
    xField?: string;
    /** Second group-by column. Only meaningful for "table" widgets with xField set — turns the grouped summary into a row × column pivot (Salesforce-style matrix report). */
    xField2?: string;
    /** Column to aggregate (sum/avg/min/max) for bar/line/area/number, or the raw y-value column for "scatter" (plotted as-is, not aggregated). Ignored for "count" and "table". */
    yField?: string;
    aggregation: Aggregation;
    /** WHERE clauses, validated against real columns; values are bound as parameters. */
    filters?: WidgetFilter[];
    /** Groups a date/datetime xField by calendar period. Ignored for scatter and for non-temporal columns. */
    xBucket?: TimeBucket;
    /** Top-N cap for grouped charts. Defaults to 50 (500 for tables); capped at 1000. */
    limit?: number;
    /** Order grouped results by aggregated value or by group label. Defaults to label for bucketed time series, value otherwise. */
    sortBy?: "value" | "label";
    sortDir?: "asc" | "desc";
    /** Conditional formatting rules, evaluated in order — first match colors the cell. */
    highlightRules?: HighlightRule[];
    createdAt: string;
}
export interface DashboardLayoutItem {
    widgetId: string;
    /** Grid position in a 12-column layout. */
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface Dashboard {
    id: string;
    title: string;
    layout: DashboardLayoutItem[];
    /** Off by default — embedding must be explicitly enabled per dashboard. */
    embedEnabled: boolean;
    /** Random token required by the public embed endpoint. Regenerated when embedding is toggled on, or on rotate. */
    shareToken: string | null;
    /**
     * When the current share token stops working, ISO-8601. A share link is
     * handed out once and lives forever in whatever wiki or email it was pasted
     * into, so it expires by default rather than on someone remembering to
     * revoke it. `null` means non-expiring: either a deliberate choice, or a
     * token created before expiry existed.
     */
    shareTokenExpiresAt?: string | null;
    createdAt: string;
}
