export type ChartType = "bar" | "line" | "pie" | "number" | "table";
export type Aggregation = "count" | "sum" | "avg" | "min" | "max";

export interface Widget {
  id: string;
  title: string;
  connectionId: string;
  schema?: string;
  table: string;
  chartType: ChartType;
  /** Column to group by (bar/line/pie). Ignored for "number" and "table". */
  xField?: string;
  /** Column to aggregate (sum/avg/min/max). Ignored for "count" and "table". */
  yField?: string;
  aggregation: Aggregation;
  /** Simple equality filters applied as WHERE col = value, validated against real columns. */
  filters?: { column: string; value: string }[];
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
