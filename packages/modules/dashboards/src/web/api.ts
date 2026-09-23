import type { ConnectionConfig, TableDefinition } from "@pilaniaanand/driver-interface";

/**
 * Standalone fetch client, duplicated (rather than imported) from the host
 * app's `@/lib/api` so this package stays a self-contained peer of `react`,
 * with no import reaching back into the app hosting it — same pattern
 * record-create's NewRowDialog used for its own POST call.
 */
const BASE = "/api";
const seg = (value: string) => encodeURIComponent(value);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body != null) headers.set("Content-Type", "application/json");
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error((body && body.error) || `Request failed: ${res.status}`);
    }
    return body as T;
}

export interface HighlightRule {
    /** Cell/value key to test — "y" for any aggregated value, or a raw column name for an ungrouped table. Omit to match the widget's primary value wherever it appears. */
    column?: string;
    operator: "gt" | "gte" | "lt" | "lte" | "eq";
    value: number;
    color: string;
}

export type FilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "in" | "is null" | "is not null";
export type TimeBucket = "day" | "week" | "month" | "quarter" | "year";

export interface WidgetFilter {
    column: string;
    /** Defaults to "=" when absent. */
    op?: FilterOperator;
    /**
     * Comma-separated for "in"; unused for the null checks. May also be a
     * dashboard-parameter placeholder `{{param_name}}` instead of a literal —
     * see `placeholderName`/`widgetParamNames` below.
     */
    value: string;
}

/** Matches a whole filter value of the form `{{param_name}}` — a dashboard-parameter placeholder, not a literal. */
const PLACEHOLDER_RE = /^\{\{(\w+)\}\}$/;

/** Returns the param name a filter value references, or undefined for a literal value. */
export function placeholderName(value: string): string | undefined {
    return PLACEHOLDER_RE.exec(value)?.[1];
}

/** Every distinct dashboard-parameter name this widget's filters reference. */
export function widgetParamNames(widget: Pick<Widget, "filters">): string[] {
    const names = (widget.filters ?? []).map((f) => placeholderName(f.value)).filter((n): n is string => !!n);
    return [...new Set(names)];
}

export interface DashboardParameter {
    /** Placeholder name a widget filter references as `{{name}}`. */
    name: string;
    label: string;
    type: "text" | "number" | "date" | "select";
    defaultValue?: unknown;
    /** Only meaningful for type "select". */
    options?: string[];
}

export interface Widget {
    id: string;
    title: string;
    connectionId: string;
    schema?: string;
    table: string;
    /** Any type registered via chartTypes.ts's registerChartType — built-ins are "bar" | "line" | "area" | "scatter" | "pie" | "number" | "table" | "pivot". */
    chartType: string;
    xField?: string;
    /** Second group-by column — only meaningful for a "table" widget with xField set, turning it into a row × column pivot. */
    xField2?: string;
    yField?: string;
    aggregation: "count" | "sum" | "avg" | "min" | "max";
    filters?: WidgetFilter[];
    /** Groups a date/datetime xField by calendar period instead of by exact timestamp. */
    xBucket?: TimeBucket;
    /** Top-N cap, 1–1000. Server default is 50 (500 for tables and scatters). */
    limit?: number;
    /** Order grouped results by aggregated value or by group label. */
    sortBy?: "value" | "label";
    sortDir?: "asc" | "desc";
    highlightRules?: HighlightRule[];
    /** Missing/undefined means "chart" — every widget saved before this existed. */
    kind?: "chart" | "text";
    /** Author-entered markdown/plain text, only meaningful for kind "text". */
    content?: string;
    /** Dashboard-parameter name set by a data-point click on this widget (cross-filtering, B2). */
    clickParameter?: string;
    /** Clicking a data point opens the table browser pre-filtered (drill-to-detail, B3); derived from this widget's table/xField. */
    drillEnabled?: boolean;
    createdAt: string;
}

export interface WidgetData {
    rows: Record<string, unknown>[];
    xKey: string;
    yKey: string;
    x2Key?: string;
}

export interface DashboardLayoutItem {
    widgetId: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

/** A dated event marker (e.g. "deploy shipped") shown in the dashboard's Annotations strip. */
export interface DashboardAnnotation {
    id: string;
    /** ISO-8601 date (no time component). */
    date: string;
    label: string;
    color?: string;
}

export interface Dashboard {
    id: string;
    title: string;
    layout: DashboardLayoutItem[];
    /** Filter-bar controls rendered above the widget grid. */
    parameters?: DashboardParameter[];
    /** Free-text grouping label for the dashboard list. Absent means ungrouped. */
    folder?: string;
    /** Dated event markers — see DashboardAnnotation. */
    annotations?: DashboardAnnotation[];
    embedEnabled: boolean;
    shareToken: string | null;
    /** ISO-8601, or null for a non-expiring token. */
    shareTokenExpiresAt?: string | null;
    /** HMAC key for the signed-embed path — see the module's server routes.ts. */
    embedSecret?: string | null;
    createdAt: string;
}

export const dashboardApi = {
    listWidgets: () => request<Widget[]>("/widgets"),
    createWidget: (input: Omit<Widget, "id" | "createdAt">) =>
        request<Widget>("/widgets", { method: "POST", body: JSON.stringify(input) }),
    updateWidget: (id: string, patch: Partial<Widget>) =>
        request<Widget>(`/widgets/${seg(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteWidget: (id: string) => request<void>(`/widgets/${seg(id)}`, { method: "DELETE" }),
    /** `params` resolves any `{{param_name}}` filter on this widget; omitted (or empty) it behaves exactly as before. */
    widgetData: (id: string, params?: Record<string, unknown>) => {
        const query =
            params && Object.keys(params).length ? `?params=${encodeURIComponent(JSON.stringify(params))}` : "";
        return request<WidgetData>(`/widgets/${seg(id)}/data${query}`);
    },

    listDashboards: () => request<Dashboard[]>("/dashboards"),
    createDashboard: (title: string) =>
        request<Dashboard>("/dashboards", { method: "POST", body: JSON.stringify({ title }) }),
    getDashboard: (id: string) => request<Dashboard>(`/dashboards/${seg(id)}`),
    updateDashboard: (
        id: string,
        patch: {
            title?: string;
            layout?: DashboardLayoutItem[];
            parameters?: DashboardParameter[];
            folder?: string;
            annotations?: DashboardAnnotation[];
        }
    ) => request<Dashboard>(`/dashboards/${seg(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteDashboard: (id: string) => request<void>(`/dashboards/${seg(id)}`, { method: "DELETE" }),
    setEmbed: (id: string, enabled: boolean) =>
        request<Dashboard>(`/dashboards/${seg(id)}/embed`, { method: "POST", body: JSON.stringify({ enabled }) }),
    rotateEmbedToken: (id: string) => request<Dashboard>(`/dashboards/${seg(id)}/embed/rotate`, { method: "POST" }),
};

/**
 * The two core-app reads WidgetForm needs (connection list, table schema).
 * Duplicated as thin one-line wrappers rather than importing the app's `api`
 * client, to keep this package's only reverse dependency on the host app the
 * two DI hooks (registerNavView / plugin options) — same boundary record-
 * create's NewRowDialog kept for its own POST call.
 */
export const coreApi = {
    listConnections: () => request<ConnectionConfig[]>("/connections"),
    listTables: (id: string) => request<TableDefinition[]>(`/connections/${seg(id)}/tables`),
};
