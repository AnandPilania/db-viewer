import type {
  ConnectionConfig,
  QueryExecResult,
  QueryFilter,
  QueryRowsResult,
  RowCountEstimate,
  RowCountExact,
  SchemaSummary,
  TableDefinition,
} from "@db-viewer/driver-interface";

const BASE = "/api";

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
  capabilities: { transactions: boolean; schemas: boolean; streaming: boolean; cancellation: boolean };
}

export const api = {
  listDrivers: () => request<DriverInfo[]>("/drivers"),

  listConnections: () => request<ConnectionConfig[]>("/connections"),

  createConnection: (input: Omit<ConnectionConfig, "id">) =>
    request<ConnectionConfig>("/connections", { method: "POST", body: JSON.stringify(input) }),

  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: "DELETE" }),

  listSchemas: (id: string) => request<SchemaSummary[]>(`/connections/${id}/schemas`),

  listTables: (id: string, schema?: string) =>
    request<TableDefinition[]>(`/connections/${id}/tables${schema ? `?schema=${schema}` : ""}`),

  describeTable: (id: string, table: string, schema?: string) =>
    request<TableDefinition>(`/connections/${id}/tables/${table}${schema ? `?schema=${schema}` : ""}`),

  queryRows: (
    id: string,
    table: string,
    opts: { schema?: string; pageSize: number; afterCursor?: string | null; filters?: QueryFilter[] }
  ) =>
    request<QueryRowsResult>(`/connections/${id}/tables/${table}/rows`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  estimateCount: (id: string, table: string, schema?: string) =>
    request<RowCountEstimate>(`/connections/${id}/tables/${table}/count/estimate${schema ? `?schema=${schema}` : ""}`),

  countExact: (id: string, table: string, schema?: string) =>
    request<RowCountExact>(`/connections/${id}/tables/${table}/count/exact${schema ? `?schema=${schema}` : ""}`),

  execute: (id: string, sql: string, params?: unknown[]) =>
    request<QueryExecResult>(`/connections/${id}/execute`, { method: "POST", body: JSON.stringify({ sql, params }) }),

  updateCell: (
    id: string,
    table: string,
    payload: { schema?: string; primaryKey: Record<string, unknown>; column: string; value: unknown }
  ) =>
    request<{ ok: true }>(`/connections/${id}/tables/${table}/cell`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
};
