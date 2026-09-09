export type ChartType = "bar" | "line" | "area" | "scatter" | "pie" | "number" | "table";
export type Aggregation = "count" | "sum" | "avg" | "min" | "max";
export type HighlightOperator = "gt" | "gte" | "lt" | "lte" | "eq";
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
    /** Simple equality filters applied as WHERE col = value, validated against real columns. */
    filters?: {
        column: string;
        value: string;
    }[];
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
    /** Random token required by the public embed endpoint. Regenerated when embedding is toggled on. */
    shareToken: string | null;
    createdAt: string;
}
