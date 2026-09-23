/** Any string registered via chart-shapes.ts's registerChartTypeShape — the built-ins are "bar" | "line" | "area" | "scatter" | "pie" | "number" | "table" | "pivot". */
export type ChartType = string;
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
  /**
   * Comma-separated for "in"; ignored for "is null"/"is not null". May also be
   * a dashboard-parameter placeholder of the form `{{param_name}}` (see
   * `Dashboard.parameters` below and chart-query.ts's `resolveFilterValue`),
   * resolved against the caller-supplied `params` at query time instead of
   * being a literal.
   */
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
  /** Discriminant. Missing/undefined means "chart" — every widget saved before this field existed. */
  kind?: "chart" | "text";
  /** Author-entered markdown/plain text, only meaningful for kind "text". No query is ever run for a text widget. */
  content?: string;
  /**
   * Dashboard-parameter name (see Dashboard.parameters) set by a data-point
   * click on this widget — cross-filtering (B2). Mutually exclusive with
   * `drillEnabled` in the authoring UI; if both are somehow set, cross-filter
   * wins (see DashboardBuilder's click handler).
   */
  clickParameter?: string;
  /**
   * When true, clicking a data point opens the app's table browser
   * pre-filtered to the underlying rows — table/column are not stored
   * separately, they're derived from this same widget's `table`/`xField`
   * (drill-to-detail, B3).
   */
  drillEnabled?: boolean;
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

/** Author-configured dashboard-level filter-bar control. See chart-query.ts's `params` argument. */
export interface DashboardParameter {
  /** Placeholder name a widget filter references as `{{name}}`. */
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select";
  defaultValue?: unknown;
  /** Only meaningful for type "select". */
  options?: string[];
}

/** A dated event marker (e.g. "deploy shipped") shown in the dashboard's Annotations strip. */
export interface DashboardAnnotation {
  id: string;
  /** ISO-8601 date (no time component needed — this pins to a day, not a moment). */
  date: string;
  label: string;
  /** CSS color for the marker. Defaults client-side when absent. */
  color?: string;
}

export interface Dashboard {
  id: string;
  title: string;
  layout: DashboardLayoutItem[];
  /** Filter-bar controls rendered above the widget grid. Empty/absent for dashboards created before this existed. */
  parameters?: DashboardParameter[];
  /** Free-text grouping label for the dashboard list — a flat tag, not a folder tree. Absent means ungrouped. */
  folder?: string;
  /** Dated event markers, e.g. "deploy shipped" — see DashboardAnnotation. Empty/absent for dashboards created before this existed. */
  annotations?: DashboardAnnotation[];
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
  /**
   * HMAC key for the signed-embed path (see routes.ts's `authorizeSignedEmbed`).
   * Generated/rotated alongside `shareToken` — a host app mints its own JWT
   * with this secret to lock embed params to a viewer's identity. `null`
   * before embedding has ever been enabled.
   */
  embedSecret: string | null;
  createdAt: string;
}
