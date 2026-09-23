import type {
    ConnectionConfig,
    ExecSpec,
    QueryExecResult,
    FilterNode,
    QueryLanguage,
    QueryRowsResult,
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
    const headers = new Headers(init?.headers);
    if (init?.body != null) headers.set("Content-Type", "application/json");
    const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers,
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
    capabilities: {
        transactions: boolean;
        schemas: boolean;
        streaming: boolean;
        cancellation: boolean;
        queryLanguage: QueryLanguage;
    };
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

    updateConnection: (id: string, patch: Partial<Omit<ConnectionConfig, "id">>) =>
        request<ConnectionConfig>(`/connections/${seg(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),

    deleteConnection: (id: string) => request<void>(`/connections/${seg(id)}`, { method: "DELETE" }),

    testNewConnection: (input: Omit<ConnectionConfig, "id">) =>
        request<{ ok: boolean; message?: string }>("/connections/test", {
            method: "POST",
            body: JSON.stringify(input),
        }),

    testExistingConnection: (id: string, patch: Partial<Omit<ConnectionConfig, "id">> = {}) =>
        request<{ ok: boolean; message?: string }>(`/connections/${seg(id)}/test`, {
            method: "POST",
            body: JSON.stringify(patch),
        }),

    listSchemas: (id: string) => request<SchemaSummary[]>(`/connections/${seg(id)}/schemas`),

    listTables: (id: string, schema?: string) =>
        request<TableDefinition[]>(`/connections/${seg(id)}/tables${schema ? `?schema=${seg(schema)}` : ""}`),

    describeTable: (id: string, table: string, schema?: string) =>
        request<TableDefinition>(
            `/connections/${seg(id)}/tables/${seg(table)}${schema ? `?schema=${seg(schema)}` : ""}`
        ),

    queryRows: (
        id: string,
        table: string,
        opts: {
            schema?: string;
            pageSize: number;
            afterCursor?: string | null;
            /** Sort-key values to jump to (inclusive), as an alternative to a cursor. */
            seek?: unknown[] | null;
            filters?: FilterNode[];
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
        request<RowCountEstimate>(
            `/connections/${seg(id)}/tables/${seg(table)}/count/estimate${schema ? `?schema=${seg(schema)}` : ""}`
        ),

    countExact: (id: string, table: string, schema?: string) =>
        request<RowCountExact>(
            `/connections/${seg(id)}/tables/${seg(table)}/count/exact${schema ? `?schema=${seg(schema)}` : ""}`
        ),

    execute: (id: string, query: ExecSpec) =>
        request<QueryExecResult>(`/connections/${seg(id)}/execute`, {
            method: "POST",
            body: JSON.stringify({ query }),
        }),

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

// Dashboard/widget types and `dashboardApi` moved into
// `@pilaniaanand/module-dashboards/web` (its own self-contained `api.ts`) as
// part of the dashboards module extraction — see that package for the
// equivalent client.
