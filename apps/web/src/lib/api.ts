import type {
    ConnectionConfig,
    ExecSpec,
    QueryExecResult,
    QueryFilter,
    QueryLanguage,
    QueryRowsResult,
    QuerySpec,
    RowCountEstimate,
    RowCountExact,
    SchemaSummary,
    TableDefinition,
} from "@pilaniaanand/driver-interface";

const BASE = "/api";

/**
 * Path segments must be encoded, not interpolated. Real schemas contain
 * table names with spaces, dots, slashes, `#`, and `?` — every one of which
 * silently produced a different URL (or a 404) when dropped into a template
 * string raw. nanoid ids are URL-safe already, but they go through the same
 * helper so no call site has to remember which is which.
 */
const seg = (value: string) => encodeURIComponent(value);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error((body && body.error) || `Request failed: ${res.status}`);
    }
    return body as T;
}

export interface DriverInfo {
    key: string;
    displayName: string;
    capabilities: { transactions: boolean; schemas: boolean; streaming: boolean; cancellation: boolean; queryLanguage: QueryLanguage };
}

export interface UninstalledDriverInfo {
    key: string;
    packageName: string;
    displayName: string;
}

export interface DriversResponse {
    active: DriverInfo[];
    notInstalled: UninstalledDriverInfo[];
}

export const api = {
    listDrivers: () => request<DriversResponse>("/drivers"),

    listConnections: () => request<ConnectionConfig[]>("/connections"),

    createConnection: (input: Omit<ConnectionConfig, "id">) =>
        request<ConnectionConfig>("/connections", { method: "POST", body: JSON.stringify(input) }),

    deleteConnection: (id: string) => request<void>(`/connections/${seg(id)}`, { method: "DELETE" }),

    listSchemas: (id: string) => request<SchemaSummary[]>(`/connections/${seg(id)}/schemas`),

    listTables: (id: string, schema?: string) =>
        request<TableDefinition[]>(`/connections/${seg(id)}/tables${schema ? `?schema=${seg(schema)}` : ""}`),

    describeTable: (id: string, table: string, schema?: string) =>
        request<TableDefinition>(`/connections/${seg(id)}/tables/${seg(table)}${schema ? `?schema=${seg(schema)}` : ""}`),

    queryRows: (
        id: string,
        table: string,
        opts: {
            schema?: string;
            pageSize: number;
            afterCursor?: string | null;
            /** Sort-key values to jump to (inclusive), as an alternative to a cursor. */
            seek?: unknown[] | null;
            filters?: QueryFilter[];
            sort?: { column: string; direction: "asc" | "desc" }[];
            signal?: AbortSignal;
        }
    ) => {
        const { signal, ...body } = opts;
        return request<QueryRowsResult>(`/connections/${seg(id)}/tables/${seg(table)}/rows`, {
            method: "POST",
            body: JSON.stringify(body),
            signal,
        });
    },

    estimateCount: (id: string, table: string, schema?: string) =>
        request<RowCountEstimate>(`/connections/${seg(id)}/tables/${seg(table)}/count/estimate${schema ? `?schema=${seg(schema)}` : ""}`),

    countExact: (id: string, table: string, schema?: string) =>
        request<RowCountExact>(`/connections/${seg(id)}/tables/${seg(table)}/count/exact${schema ? `?schema=${seg(schema)}` : ""}`),

    execute: (id: string, query: ExecSpec) =>
        request<QueryExecResult>(`/connections/${seg(id)}/execute`, { method: "POST", body: JSON.stringify({ query }) }),

    updateCell: (
        id: string,
        table: string,
        payload: { schema?: string; primaryKey: Record<string, unknown>; column: string; value: unknown }
    ) =>
        request<{ ok: true }>(`/connections/${seg(id)}/tables/${seg(table)}/cell`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        }),

    insertRow: (id: string, table: string, payload: { schema?: string; values: Record<string, unknown> }) =>
        request<Record<string, unknown>>(`/connections/${seg(id)}/tables/${seg(table)}/records`, {
            method: "POST",
            body: JSON.stringify(payload),
        }),

    deleteRow: (id: string, table: string, payload: { schema?: string; primaryKey: Record<string, unknown> }) =>
        request<void>(`/connections/${seg(id)}/tables/${seg(table)}/records`, {
            method: "DELETE",
            body: JSON.stringify(payload),
        }),
};

export interface HighlightRule {
    /** Cell/value key to test — "y" for any aggregated value, or a raw column name for an ungrouped table. Omit to match the widget's primary value wherever it appears. */
    column?: string;
    operator: "gt" | "gte" | "lt" | "lte" | "eq";
    value: number;
    color: string;
}

export interface Widget {
    id: string;
    title: string;
    connectionId: string;
    schema?: string;
    table: string;
    chartType: "bar" | "line" | "area" | "scatter" | "pie" | "number" | "table";
    xField?: string;
    /** Second group-by column — only meaningful for a "table" widget with xField set, turning it into a row × column pivot. */
    xField2?: string;
    yField?: string;
    aggregation: "count" | "sum" | "avg" | "min" | "max";
    filters?: { column: string; value: string }[];
    highlightRules?: HighlightRule[];
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

export interface Dashboard {
    id: string;
    title: string;
    layout: DashboardLayoutItem[];
    embedEnabled: boolean;
    shareToken: string | null;
    createdAt: string;
}

export const dashboardApi = {
    listWidgets: () => request<Widget[]>("/widgets"),
    createWidget: (input: Omit<Widget, "id" | "createdAt">) =>
        request<Widget>("/widgets", { method: "POST", body: JSON.stringify(input) }),
    updateWidget: (id: string, patch: Partial<Widget>) =>
        request<Widget>(`/widgets/${seg(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteWidget: (id: string) => request<void>(`/widgets/${seg(id)}`, { method: "DELETE" }),
    widgetData: (id: string) => request<WidgetData>(`/widgets/${seg(id)}/data`),

    listDashboards: () => request<Dashboard[]>("/dashboards"),
    createDashboard: (title: string) => request<Dashboard>("/dashboards", { method: "POST", body: JSON.stringify({ title }) }),
    getDashboard: (id: string) => request<Dashboard>(`/dashboards/${seg(id)}`),
    updateDashboard: (id: string, patch: { title?: string; layout?: DashboardLayoutItem[] }) =>
        request<Dashboard>(`/dashboards/${seg(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteDashboard: (id: string) => request<void>(`/dashboards/${seg(id)}`, { method: "DELETE" }),
    setEmbed: (id: string, enabled: boolean) =>
        request<Dashboard>(`/dashboards/${seg(id)}/embed`, { method: "POST", body: JSON.stringify({ enabled }) }),
};
