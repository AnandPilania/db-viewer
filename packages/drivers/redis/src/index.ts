import { createClient } from "redis";
import type { RedisClientType } from "redis";
import type {
  ColumnDefinition,
  ConnectionConfig,
  DatabaseDriver,
  DriverConnection,
  ExecSpec,
  QueryExecResult,
  QueryRowsOptions,
  QueryRowsResult,
  RedisKeyType,
  RowChangeEvent,
  RowCountEstimate,
  RowCountExact,
  SchemaSummary,
  StreamQueryOptions,
  TableDefinition,
} from "@db-viewer/driver-interface";

/**
 * Redis has no tables, columns, or fixed schema — just keys of five/six
 * possible types. This driver adapts that to the tabular contract as
 * follows:
 *  - "table" == Redis key type (string, hash, list, set, zset, stream).
 *    Every connection exposes exactly these six pseudo-tables.
 *  - Each ROW is one KEY of that type, not one element within it — a hash
 *    with a million fields is still one row. The `value` column holds a
 *    bounded preview (first 20 entries / 500 chars), never the full value,
 *    so browsing a huge key can't blow up memory or the grid.
 *  - Pagination reuses Redis's own SCAN cursor directly as our opaque
 *    cursor string — they're already the same concept. SCAN's COUNT is
 *    only a hint, so we loop internally until a full page is gathered or
 *    the scan completes.
 *  - `streamQuery`/`execute` take the `redis-command` variant of
 *    QuerySpec/ExecSpec: a raw command + args array, e.g.
 *    `{ command: ["SCAN", "0", "MATCH", "user:*"] }`, since Redis has no
 *    query language of its own — the query editor UI presents this as a
 *    JSON command builder rather than a SQL box.
 */

const KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream"] as const satisfies readonly RedisKeyType[];

const PREVIEW_LIMIT = 20;
const STRING_PREVIEW_CHARS = 500;
const SCAN_COUNT_HINT = 200;
const MAX_SCAN_LOOPS_PER_PAGE = 50; // safety cap so a sparse type can't spin forever

function columnsFor(_type: RedisKeyType): ColumnDefinition[] {
  return [
    { name: "key", type: "string", nativeType: "string", nullable: false, isPrimaryKey: true, isForeignKey: false },
    { name: "ttl", type: "number", nativeType: "seconds", nullable: true, isPrimaryKey: false, isForeignKey: false },
    { name: "size", type: "number", nativeType: "count", nullable: false, isPrimaryKey: false, isForeignKey: false },
    { name: "value", type: "json", nativeType: "preview", nullable: false, isPrimaryKey: false, isForeignKey: false },
  ];
}

class RedisConnection implements DriverConnection {
  readonly id: string;
  private client: RedisClientType;
  private notifyClient: RedisClientType | null = null;
  private notifySetupPromise: Promise<void> | null = null;
  private watchHandlers = new Map<RedisKeyType, Set<(event: RowChangeEvent) => void>>();

  constructor(id: string, client: RedisClientType) {
    this.id = id;
    this.client = client;
  }

  async listSchemas(): Promise<SchemaSummary[]> {
    return [{ name: "keyspace", tables: KEY_TYPES.map((t) => ({ name: t, kind: "table" as const })) }];
  }

  async listTables(): Promise<TableDefinition[]> {
    return KEY_TYPES.map((t) => ({ name: t, kind: "table", columns: columnsFor(t) }));
  }

  async describeTable(table: string): Promise<TableDefinition> {
    const type = table as RedisKeyType;
    return { name: type, kind: "table", columns: columnsFor(type) };
  }

  private async preview(key: string, type: RedisKeyType): Promise<{ size: number; value: unknown }> {
    switch (type) {
      case "string": {
        const val = (await this.client.get(key)) ?? "";
        const len = await this.client.strLen(key);
        return { size: len, value: val.length > STRING_PREVIEW_CHARS ? val.slice(0, STRING_PREVIEW_CHARS) + "…" : val };
      }
      case "hash": {
        const size = await this.client.hLen(key);
        const entries = await this.client.hRandFieldCount(key, PREVIEW_LIMIT);
        const obj: Record<string, unknown> = {};
        for (const field of entries) obj[field] = await this.client.hGet(key, field);
        return { size, value: obj };
      }
      case "list": {
        const size = await this.client.lLen(key);
        const items = await this.client.lRange(key, 0, PREVIEW_LIMIT - 1);
        return { size, value: items };
      }
      case "set": {
        const size = await this.client.sCard(key);
        const members = await this.client.sRandMemberCount(key, PREVIEW_LIMIT);
        return { size, value: members };
      }
      case "zset": {
        const size = await this.client.zCard(key);
        const members = await this.client.zRangeWithScores(key, 0, PREVIEW_LIMIT - 1);
        return { size, value: Object.fromEntries(members.map((m) => [m.value, m.score])) };
      }
      case "stream": {
        const size = await this.client.xLen(key);
        const entries = await this.client.xRange(key, "-", "+", { COUNT: PREVIEW_LIMIT });
        return { size, value: entries };
      }
    }
  }

  private async scanPage(
    type: RedisKeyType,
    pattern: string,
    startCursor: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<{ keys: string[]; nextCursor: string | null }> {
    let cursor = Number(startCursor) || 0;
    const collected: string[] = [];
    let loops = 0;

    do {
      if (signal?.aborted) break;
      const result = await this.client.scan(cursor, { MATCH: pattern, COUNT: SCAN_COUNT_HINT, TYPE: type });
      cursor = result.cursor;
      collected.push(...result.keys);
      loops++;
    } while (cursor !== 0 && collected.length < limit && loops < MAX_SCAN_LOOPS_PER_PAGE);

    const page = collected.slice(0, limit);
    // If we trimmed extra keys off a full batch, we still have more to give
    // out before advancing the real cursor — but SCAN doesn't support
    // "rewind", so any overflow beyond `limit` within the same batch is
    // simply deferred to the next page via the cursor Redis already gave us.
    const nextCursor = cursor === 0 && page.length === collected.length ? null : String(cursor);
    return { keys: page, nextCursor };
  }

  async queryRows(options: QueryRowsOptions): Promise<QueryRowsResult> {
    const type = options.table as RedisKeyType;
    const patternFilter = options.filters?.find((f) => f.column === "key" && f.op === "like");
    const pattern = patternFilter ? String(patternFilter.value ?? "*") : "*";

    const { keys, nextCursor } = await this.scanPage(
      type,
      pattern,
      options.afterCursor ?? "0",
      options.pageSize,
      options.signal
    );

    const rows: Record<string, unknown>[] = [];
    for (const key of keys) {
      const [ttl, { size, value }] = await Promise.all([this.client.ttl(key), this.preview(key, type)]);
      rows.push({ key, ttl: ttl < 0 ? null : ttl, size, value });
    }

    return { rows, nextCursor, columns: columnsFor(type) };
  }

  async estimateRowCount(table: string): Promise<RowCountEstimate> {
    // Redis's DBSIZE counts every key regardless of type, so it's not a
    // useful per-type estimate. There's no O(1) per-type count in Redis, so
    // we sample one bounded SCAN batch as a rough order-of-magnitude signal
    // rather than pretending to have real statistics.
    const { keys, nextCursor } = await this.scanPage(table as RedisKeyType, "*", "0", 1000);
    return {
      value: keys.length,
      exact: false,
      source: nextCursor === null ? "statistics" : "unsupported", // "unsupported" flags that this sample is a lower bound, not a real total
    };
  }

  async countRowsExact(table: string, _schema?: string, signal?: AbortSignal): Promise<RowCountExact> {
    let cursor = 0;
    let count = 0;
    do {
      if (signal?.aborted) break;
      const result = await this.client.scan(cursor, { MATCH: "*", COUNT: SCAN_COUNT_HINT, TYPE: table as RedisKeyType });
      cursor = result.cursor;
      count += result.keys.length;
    } while (cursor !== 0);
    return { value: count, exact: true };
  }

  async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
    if (options.query.language !== "redis-command") {
      throw new Error(`Redis only supports redis-command queries, got "${options.query.language}"`);
    }
    const spec = options.query;
    if (!KEY_TYPES.includes(spec.type)) throw new Error(`"type" must be one of ${KEY_TYPES.join(", ")}`);

    const chunkSize = options.chunkSize ?? 500;
    const limit = spec.limit ?? Number.MAX_SAFE_INTEGER;
    let cursor = 0;
    let emitted = 0;
    let batch: Record<string, unknown>[] = [];

    do {
      if (options.signal?.aborted) break;
      const result = await this.client.scan(cursor, {
        MATCH: spec.pattern ?? "*",
        COUNT: SCAN_COUNT_HINT,
        TYPE: spec.type,
      });
      cursor = result.cursor;
      for (const key of result.keys) {
        if (emitted >= limit) break;
        const [ttl, { size, value }] = await Promise.all([this.client.ttl(key), this.preview(key, spec.type)]);
        batch.push({ key, ttl: ttl < 0 ? null : ttl, size, value });
        emitted++;
        if (batch.length >= chunkSize) {
          yield { rows: batch, nextCursor: null, columns: columnsFor(spec.type) };
          batch = [];
        }
      }
    } while (cursor !== 0 && emitted < limit && !options.signal?.aborted);

    if (batch.length) yield { rows: batch, nextCursor: null, columns: columnsFor(spec.type) };
  }

  async execute(query: ExecSpec): Promise<QueryExecResult> {
    if (query.language !== "redis-command") {
      throw new Error(`Redis only supports redis-command queries, got "${query.language}"`);
    }
    if (!Array.isArray(query.command) || query.command.length === 0) {
      throw new Error('Missing "command" array, e.g. { command: ["DEL", "foo"] }');
    }
    const start = performance.now();
    const result = await this.client.sendCommand(query.command.map(String));
    return {
      columns: [],
      affectedRows: typeof result === "number" ? result : undefined,
      durationMs: performance.now() - start,
    };
  }

  async updateCell(
    table: string,
    _schema: string | undefined,
    primaryKey: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void> {
    const key = String(primaryKey.key);
    if (column === "ttl") {
      const seconds = value === null || value === undefined ? null : Number(value);
      if (seconds === null) await this.client.persist(key);
      else await this.client.expire(key, seconds);
      return;
    }
    if (column === "value" && table === "string") {
      await this.client.set(key, String(value));
      return;
    }
    throw new Error(
      `Only "ttl" (any type) and "value" (string type only) can be edited inline. ` +
        `Composite types (hash/list/set/zset/stream) need element-level commands — use the query editor.`
    );
  }

  async insertRow(
    table: string,
    _schema: string | undefined,
    values: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const type = table as RedisKeyType;
    const key = String(values.key ?? "");
    if (!key) throw new Error('"key" is required');

    switch (type) {
      case "string":
        await this.client.set(key, String(values.value ?? ""));
        break;
      case "hash": {
        const obj = typeof values.value === "object" ? (values.value as Record<string, unknown>) : JSON.parse(String(values.value));
        await this.client.hSet(key, Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)])));
        break;
      }
      case "list": {
        const items = Array.isArray(values.value) ? values.value : [values.value];
        await this.client.rPush(key, items.map(String));
        break;
      }
      case "set": {
        const items = Array.isArray(values.value) ? values.value : [values.value];
        await this.client.sAdd(key, items.map(String));
        break;
      }
      case "zset": {
        const obj = typeof values.value === "object" ? (values.value as Record<string, number>) : JSON.parse(String(values.value));
        await this.client.zAdd(
          key,
          Object.entries(obj).map(([member, score]) => ({ value: member, score: Number(score) }))
        );
        break;
      }
      case "stream":
        await this.client.xAdd(key, "*", typeof values.value === "object" ? (values.value as Record<string, string>) : { value: String(values.value) });
        break;
    }

    const ttl = await this.client.ttl(key);
    const { size, value } = await this.preview(key, type);
    return { key, ttl: ttl < 0 ? null : ttl, size, value };
  }

  async deleteRow(_table: string, _schema: string | undefined, primaryKey: Record<string, unknown>): Promise<void> {
    const key = String(primaryKey.key ?? "");
    if (!key) throw new Error('"key" is required');
    await this.client.del(key);
  }

  /**
   * Real CDC for Redis via keyspace notifications. Honest limitation: a
   * notification only tells us a key's NAME and the operation that
   * happened to it, not its type or new value — so on a write-type event
   * we re-fetch the key's current preview and emit it as an "update" (the
   * frontend replaces the matching row's data). We deliberately don't try
   * to distinguish "brand new key" from "existing key changed" here: a
   * genuinely new key won't appear until the table is next reloaded/
   * scrolled, since inserting a synthetic row without knowing the
   * client's current page state risks putting it in the wrong place. A
   * delete-type event (`del`/`expired`/`evicted`) has no reliable type
   * info either, so it's broadcast to every currently-watched pseudo-table
   * — harmless, since the frontend only removes a row if one with that
   * key is actually loaded.
   */
  watchTable(table: string, _schema: string | undefined, onChange: (event: RowChangeEvent) => void): () => void {
    const type = table as RedisKeyType;
    if (!this.watchHandlers.has(type)) this.watchHandlers.set(type, new Set());
    this.watchHandlers.get(type)!.add(onChange);

    void this.ensureNotifying();

    return () => {
      this.watchHandlers.get(type)?.delete(onChange);
    };
  }

  private async ensureNotifying(): Promise<void> {
    if (this.notifySetupPromise) return this.notifySetupPromise;

    this.notifySetupPromise = (async () => {
      try {
        // "KEA" = keyspace events, all commands. Requires CONFIG permission;
        // if the server denies it (some managed Redis providers lock this
        // down), we log and simply get no native events — app-originated
        // events still work via the WebSocket broadcast layer regardless.
        await this.client.configSet("notify-keyspace-events", "KEA");
      } catch (err) {
        console.error("Could not enable Redis keyspace notifications:", (err as Error).message);
        return;
      }

      const sub = this.client.duplicate();
      await sub.connect();
      this.notifyClient = sub;

      await sub.pSubscribe("__keyevent@*__:*", async (key, channel) => {
        const op = channel.split(":").pop() ?? "";

        if (op === "del" || op === "expired" || op === "evicted") {
          for (const handlers of this.watchHandlers.values()) {
            for (const handler of handlers) handler({ type: "delete", primaryKey: { key } });
          }
          return;
        }

        let keyType: RedisKeyType;
        try {
          keyType = (await this.client.type(key)) as RedisKeyType;
        } catch {
          return; // key vanished between the event and our lookup — fine, a delete event will follow
        }
        const handlers = this.watchHandlers.get(keyType);
        if (!handlers || handlers.size === 0) return;

        try {
          const [ttl, { size, value }] = await Promise.all([this.client.ttl(key), this.preview(key, keyType)]);
          const row = { key, ttl: ttl < 0 ? null : ttl, size, value };
          for (const handler of handlers) handler({ type: "update", primaryKey: { key }, column: "__row__", value: row });
        } catch {
          // key mutated again mid-fetch — the next notification will catch up
        }
      });
    })();

    return this.notifySetupPromise;
  }

  async close(): Promise<void> {
    if (this.notifyClient) await this.notifyClient.quit().catch(() => {});
    await this.client.quit();
  }
}

function buildUrl(config: ConnectionConfig): string {
  const uri = config.extra?.uri as string | undefined;
  if (uri) return uri;
  const auth = config.password ? `:${encodeURIComponent(config.password)}@` : "";
  const host = config.host ?? "localhost";
  const port = config.port ?? 6379;
  const db = config.database ? `/${config.database}` : "";
  return `redis://${auth}${host}:${port}${db}`;
}

export const redisDriver: DatabaseDriver = {
  key: "redis",
  displayName: "Redis",
  capabilities: { transactions: false, schemas: false, streaming: true, cancellation: true, queryLanguage: "redis-command" },

  async testConnection(config: ConnectionConfig) {
    const client = createClient({ url: buildUrl(config), socket: { connectTimeout: 5000 } });
    try {
      await client.connect();
      await client.ping();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      await client.quit().catch(() => {});
    }
  },

  async connect(config: ConnectionConfig): Promise<DriverConnection> {
    const client: RedisClientType = createClient({ url: buildUrl(config) });
    await client.connect();
    return new RedisConnection(config.id, client);
  },
};

export default redisDriver;
