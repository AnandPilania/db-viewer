import { MongoClient, ObjectId } from "mongodb";
import type { Collection, Db, Document, Sort } from "mongodb";
import type {
    ColumnDefinition,
    ColumnType,
    ConnectionConfig,
    DatabaseDriver,
    DriverConnection,
    QueryExecResult,
    QueryRowsOptions,
    QueryRowsResult,
    RowCountEstimate,
    RowCountExact,
    SchemaSummary,
    StreamQueryOptions,
    TableDefinition,
} from "@db-viewer/driver-interface";

const SAMPLE_SIZE = 50;

function mongoTypeOf(value: unknown): ColumnType {
    if (value === null || value === undefined) return "null";
    if (value instanceof ObjectId) return "string";
    if (value instanceof Date) return "datetime";
    if (Buffer.isBuffer(value)) return "binary";
    if (Array.isArray(value) || typeof value === "object") return "json";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "string") return "string";
    return "unknown";
}

function serializeValue(value: unknown): unknown {
    if (value instanceof ObjectId) return value.toHexString();
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString("base64");
    if (Array.isArray(value)) return value.map(serializeValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v)]));
    }
    return value;
}

function encodeCursor(id: unknown): string {
    const raw = id instanceof ObjectId ? id.toHexString() : id;
    return Buffer.from(JSON.stringify(raw)).toString("base64");
}
function decodeCursor(cursor: string): unknown {
    const raw = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
    return typeof raw === "string" && ObjectId.isValid(raw) ? new ObjectId(raw) : raw;
}

class MongoConnection implements DriverConnection {
    readonly id: string;
    private client: MongoClient;
    private db: Db;

    constructor(id: string, client: MongoClient, db: Db) {
        this.id = id;
        this.client = client;
        this.db = db;
    }

    async listSchemas(): Promise<SchemaSummary[]> {
        const tables = await this.listTables();
        return [{ name: this.db.databaseName, tables: tables.map((t) => ({ name: t.name, kind: t.kind })) }];
    }

    async listTables(): Promise<TableDefinition[]> {
        const collections = await this.db.listCollections({}, { nameOnly: true }).toArray();
        const tables: TableDefinition[] = [];
        for (const c of collections) {
            const coll = this.db.collection(c.name);
            const [columns, estimatedRowCount] = await Promise.all([
                this.inferColumns(coll),
                coll.estimatedDocumentCount().catch(() => 0),
            ]);
            tables.push({ name: c.name, kind: "collection", columns, estimatedRowCount });
        }
        return tables;
    }

    private async inferColumns(coll: Collection<Document>): Promise<ColumnDefinition[]> {
        const sample = await coll.find({}).limit(SAMPLE_SIZE).toArray();
        const fields = new Map<string, ColumnType>();
        for (const doc of sample) {
            for (const [key, value] of Object.entries(doc)) {
                if (!fields.has(key)) fields.set(key, mongoTypeOf(value));
            }
        }
        return [...fields.entries()].map(([name, type]) => ({
            name,
            type,
            nativeType: type,
            nullable: true,
            isPrimaryKey: name === "_id",
            isForeignKey: false,
        }));
    }

    async describeTable(table: string): Promise<TableDefinition> {
        const coll = this.db.collection(table);
        return { name: table, kind: "collection", columns: await this.inferColumns(coll) };
    }

    async queryRows(options: QueryRowsOptions): Promise<QueryRowsResult> {
        const coll = this.db.collection(options.table);
        const filter: Document = {};

        if (options.afterCursor) {
            filter._id = { $gt: decodeCursor(options.afterCursor) };
        }
        for (const f of options.filters ?? []) {
            if (f.op === "is_null") filter[f.column] = null;
            else if (f.op === "is_not_null") filter[f.column] = { $ne: null };
            else if (f.op === "like") filter[f.column] = { $regex: String(f.value ?? ""), $options: "i" };
            else if (f.op === "in") filter[f.column] = { $in: (f.value as unknown[]) ?? [] };
            else {
                const mongoOp = { "=": "$eq", "!=": "$ne", ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte" }[f.op];
                filter[f.column] = mongoOp ? { [mongoOp]: f.value } : f.value;
            }
        }

        const sort: Sort = options.sort?.length
            ? Object.fromEntries(options.sort.map((s) => [s.column, s.direction === "asc" ? 1 : -1]))
            : { _id: 1 };

        const docs = await coll
            .find(filter)
            .sort(sort)
            .limit(options.pageSize + 1)
            .toArray();

        const hasMore = docs.length > options.pageSize;
        const page = hasMore ? docs.slice(0, options.pageSize) : docs;
        const nextCursor = hasMore ? encodeCursor(page[page.length - 1]._id) : null;
        const rows = page.map((d) => serializeValue(d) as Record<string, unknown>);
        const columns = await this.inferColumns(coll);

        return { rows, nextCursor, columns };
    }

    async estimateRowCount(table: string): Promise<RowCountEstimate> {
        const value = await this.db.collection(table).estimatedDocumentCount();
        return { value, exact: false, source: "statistics" };
    }

    async countRowsExact(table: string, _schema?: string, signal?: AbortSignal): Promise<RowCountExact> {
        const countPromise = this.db.collection(table).countDocuments({});
        if (!signal) return { value: await countPromise, exact: true };

        const value = await new Promise<number>((resolve, reject) => {
            const onAbort = () => reject(new Error("cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
            countPromise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
        });
        return { value, exact: true };
    }

    async *streamQuery(options: StreamQueryOptions): AsyncIterableIterator<QueryRowsResult> {
        const chunkSize = options.chunkSize ?? 500;
        let spec: { collection: string; filter?: Document; sort?: Sort; limit?: number };
        try {
            spec = JSON.parse(options.sql);
        } catch {
            throw new Error(
                'MongoDB queries are JSON, e.g. {"collection":"users","filter":{"active":true},"limit":1000}'
            );
        }
        if (!spec.collection) throw new Error('Missing "collection" in query JSON');

        const coll = this.db.collection(spec.collection);
        const cursor = coll.find(spec.filter ?? {}).sort(spec.sort ?? { _id: 1 });
        if (spec.limit) cursor.limit(spec.limit);

        const onAbort = () => cursor.close();
        options.signal?.addEventListener("abort", onAbort, { once: true });

        try {
            let batch: Record<string, unknown>[] = [];
            for await (const doc of cursor) {
                if (options.signal?.aborted) break;
                batch.push(serializeValue(doc) as Record<string, unknown>);
                if (batch.length >= chunkSize) {
                    yield { rows: batch, nextCursor: null, columns: [] };
                    batch = [];
                }
            }
            if (batch.length) yield { rows: batch, nextCursor: null, columns: [] };
        } finally {
            options.signal?.removeEventListener("abort", onAbort);
            await cursor.close();
        }
    }

    async execute(sql: string): Promise<QueryExecResult> {
        // JSON command form: {"op":"insertOne"|"updateOne"|"deleteOne"|"deleteMany","collection":"x", ...}
        const start = performance.now();
        const cmd = JSON.parse(sql) as {
            op: "insertOne" | "updateOne" | "deleteOne" | "deleteMany";
            collection: string;
            filter?: Document;
            update?: Document;
            doc?: Document;
        };
        const coll = this.db.collection(cmd.collection);
        let affectedRows = 0;
        if (cmd.op === "insertOne") {
            await coll.insertOne(cmd.doc ?? {});
            affectedRows = 1;
        } else if (cmd.op === "updateOne") {
            const res = await coll.updateOne(cmd.filter ?? {}, cmd.update ?? {});
            affectedRows = res.modifiedCount;
        } else if (cmd.op === "deleteOne") {
            const res = await coll.deleteOne(cmd.filter ?? {});
            affectedRows = res.deletedCount;
        } else if (cmd.op === "deleteMany") {
            const res = await coll.deleteMany(cmd.filter ?? {});
            affectedRows = res.deletedCount;
        }
        return { columns: [], affectedRows, durationMs: performance.now() - start };
    }

    async updateCell(
        table: string,
        _schema: string | undefined,
        primaryKey: Record<string, unknown>,
        column: string,
        value: unknown
    ): Promise<void> {
        const idRaw = primaryKey._id;
        const id = typeof idRaw === "string" && ObjectId.isValid(idRaw) ? new ObjectId(idRaw) : idRaw;
        await this.db.collection(table).updateOne({ _id: id } as Document, { $set: { [column]: value } });
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

function buildConnectionString(config: ConnectionConfig): string {
    const uri = config.extra?.uri as string | undefined;
    if (uri) return uri;
    const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@` : "";
    const host = config.host ?? "localhost";
    const port = config.port ?? 27017;
    return `mongodb://${auth}${host}:${port}`;
}

export const mongodbDriver: DatabaseDriver = {
    key: "mongodb",
    displayName: "MongoDB",
    capabilities: { transactions: false, schemas: false, streaming: true, cancellation: true },

    async testConnection(config: ConnectionConfig) {
        const client = new MongoClient(buildConnectionString(config), { serverSelectionTimeoutMS: 5000 });
        try {
            await client.connect();
            await client.db(config.database).command({ ping: 1 });
            return { ok: true };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        } finally {
            await client.close();
        }
    },

    async connect(config: ConnectionConfig): Promise<DriverConnection> {
        const client = new MongoClient(buildConnectionString(config));
        await client.connect();
        const db = client.db(config.database);
        return new MongoConnection(config.id, client, db);
    },
};

export default mongodbDriver;
