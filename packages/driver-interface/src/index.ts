/**
 * @db-viewer/driver-interface
 *
 * This is the single contract every database adapter implements. The registry
 * (apps/server) only ever talks to this interface — it never imports a
 * concrete driver directly. Adding support for a new database means writing
 * one new package that implements `DatabaseDriver` and registering it; no
 * other part of the system changes.
 *
 * Design rules baked into this contract (see architecture plan):
 *  - Nothing here returns a full result set. Reads are either paginated
 *    (`queryRows`) or streamed (`streamQuery`), so a caller can never
 *    accidentally materialize a trillion-row table in memory.
 *  - Row counts are explicitly split into a fast estimate and a slow exact
 *    count, so the UI can show something instantly and let the user opt in
 *    to the expensive version.
 *  - Everything long-running is cancellable via an AbortSignal.
 */

export type ColumnType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "json"
  | "binary"
  | "null"
  | "unknown";

export interface ColumnDefinition {
  name: string;
  type: ColumnType;
  nativeType: string; // e.g. "varchar(255)", "int4", "ObjectId"
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references?: { table: string; column: string };
  defaultValue?: string | null;
}

export interface TableDefinition {
  schema?: string; // e.g. postgres schema, mysql database — omit if not applicable
  name: string;
  kind: "table" | "view" | "collection" | "materialized_view";
  columns: ColumnDefinition[];
  estimatedRowCount?: number; // from DB statistics, may be stale
}

export interface SchemaSummary {
  name: string;
  tables: Array<Pick<TableDefinition, "schema" | "name" | "kind">>;
}

export interface ConnectionConfig {
  id: string;
  driver: string; // registry key, e.g. "postgres", "mysql", "sqlite", "mongodb"
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  filePath?: string; // for file-based drivers like sqlite
  ssl?: boolean;
  extra?: Record<string, unknown>; // driver-specific overflow (e.g. mongo replica set opts)
}

export interface CursorPage {
  /** Opaque, driver-defined cursor. Callers must not parse this string. */
  cursor: string | null;
}

export interface QueryRowsOptions {
  table: string;
  schema?: string;
  columns?: string[]; // omit for all columns
  filters?: QueryFilter[];
  sort?: { column: string; direction: "asc" | "desc" }[];
  pageSize: number;
  afterCursor?: string | null; // keyset pagination — never OFFSET
  signal?: AbortSignal;
}

export interface QueryFilter {
  column: string;
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "in" | "is_null" | "is_not_null";
  value?: unknown;
}

export interface QueryRowsResult {
  rows: Record<string, unknown>[];
  nextCursor: string | null; // null => no more rows
  columns: ColumnDefinition[];
}

export interface RowCountEstimate {
  value: number;
  exact: false;
  source: "statistics" | "unsupported";
}

export interface RowCountExact {
  value: number;
  exact: true;
}

export interface StreamQueryOptions {
  sql: string;
  params?: unknown[];
  chunkSize?: number; // rows per emitted chunk, default driver-defined
  signal?: AbortSignal;
}

export interface QueryExecResult {
  columns: ColumnDefinition[];
  affectedRows?: number;
  durationMs: number;
}

/**
 * The contract. All methods are async / async-iterable so a driver can wrap
 * a network call, a local file read, or an in-process embedded engine
 * identically from the registry's point of view.
 */
export interface DatabaseDriver {
  readonly key: string; // registry key, must match ConnectionConfig.driver
  readonly displayName: string;
  readonly capabilities: {
    transactions: boolean;
    schemas: boolean; // does this DB have a schema/namespace concept above "table"?
    streaming: boolean;
    cancellation: boolean;
  };

  testConnection(config: ConnectionConfig): Promise<{ ok: boolean; message?: string }>;

  connect(config: ConnectionConfig): Promise<DriverConnection>;
}

export interface DriverConnection {
  readonly id: string;

  listSchemas(): Promise<SchemaSummary[]>;
  listTables(schema?: string): Promise<TableDefinition[]>;
  describeTable(table: string, schema?: string): Promise<TableDefinition>;

  /** Keyset-paginated row browsing for the data grid. Never uses OFFSET. */
  queryRows(options: QueryRowsOptions): Promise<QueryRowsResult>;

  /** Fast, approximate — reads DB statistics, not a full scan. */
  estimateRowCount(table: string, schema?: string): Promise<RowCountEstimate>;

  /** Slow, exact — an opt-in COUNT(*) style scan. Must respect signal. */
  countRowsExact(table: string, schema?: string, signal?: AbortSignal): Promise<RowCountExact>;

  /** Arbitrary SQL/query execution for the query editor, streamed in chunks. */
  streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult>;

  /** Non-SELECT execution (INSERT/UPDATE/DELETE/DDL), also cancellable. */
  execute(sql: string, params?: unknown[], signal?: AbortSignal): Promise<QueryExecResult>;

  updateCell(
    table: string,
    schema: string | undefined,
    primaryKey: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void>;

  close(): Promise<void>;
}
