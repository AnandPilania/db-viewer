import type { FastifyInstance } from "fastify";
import type { ExecSpec } from "@pilaniaanand/driver-interface";
import { connectionStore } from "../connection-store.js";
import { registry } from "../registry.js";
import { tableEvents } from "../table-events.js";
import { assertWritable, assertExecutable, ReadOnlyError } from "../read-only.js";

/**
 * An unbounded pageSize is an out-of-memory switch reachable by anyone who
 * can POST — the driver would build one array of that many rows before the
 * route ever sees them. The grid asks for 200 and export asks for 1000.
 */
const MAX_PAGE_SIZE = 5000;
const DEFAULT_PAGE_SIZE = 100;

function clampPageSize(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
    return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/** ReadOnlyError -> 403; everything else (driver/validation errors) -> 400, as every route already did. */
function sendError(reply: import("fastify").FastifyReply, err: unknown) {
    reply.code(err instanceof ReadOnlyError ? 403 : 400);
    return { error: (err as Error).message };
}

export async function connectionRoutes(app: FastifyInstance) {
    app.get("/api/drivers", async () => ({
        active: registry.list(),
        notInstalled: registry.listUnavailable(),
    }));

    app.get("/api/connections", async () => connectionStore.list());

    app.post("/api/connections", async (req, reply) => {
        const body = req.body as any;
        try {
            return await connectionStore.create(body);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.patch("/api/connections/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = req.body as any;
        try {
            return await connectionStore.update(id, body);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.post("/api/connections/test", async (req, reply) => {
        const body = req.body as any;
        try {
            return await connectionStore.testNew(body);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.post("/api/connections/:id/test", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body as any) ?? {};
        try {
            return await connectionStore.testExisting(id, body);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.delete("/api/connections/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        await connectionStore.remove(id);
        reply.code(204);
    });

    app.get("/api/connections/:id/schemas", async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
            const conn = await connectionStore.getLive(id);
            return await conn.listSchemas();
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.get("/api/connections/:id/tables", async (req, reply) => {
        const { id } = req.params as { id: string };
        const { schema } = req.query as { schema?: string };
        try {
            const conn = await connectionStore.getLive(id);
            return await conn.listTables(schema);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.get("/api/connections/:id/tables/:table", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema } = req.query as { schema?: string };
        try {
            const conn = await connectionStore.getLive(id);
            return await conn.describeTable(table, schema);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.post("/api/connections/:id/tables/:table/rows", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const body = (req.body as any) ?? {};
        const controller = new AbortController();
        reply.raw.on("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
        try {
            const conn = await connectionStore.getLive(id);
            return await conn.queryRows({
                table,
                schema: body.schema,
                columns: body.columns,
                filters: body.filters,
                sort: Array.isArray(body.sort) ? body.sort : undefined,
                pageSize: clampPageSize(body.pageSize),
                afterCursor: body.afterCursor ?? null,
                seek: Array.isArray(body.seek) ? body.seek : null,
                signal: controller.signal,
            });
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.get("/api/connections/:id/tables/:table/count/estimate", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema } = req.query as { schema?: string };
        try {
            const conn = await connectionStore.getLive(id);
            return await conn.estimateRowCount(table, schema);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.get("/api/connections/:id/tables/:table/count/exact", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema } = req.query as { schema?: string };
        const controller = new AbortController();
        reply.raw.on("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
        try {
            const conn = await connectionStore.getLive(id);
            return await conn.countRowsExact(table, schema, controller.signal);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.post("/api/connections/:id/execute", async (req, reply) => {
        const { id } = req.params as { id: string };
        const { query } = req.body as { query: ExecSpec };
        const controller = new AbortController();
        reply.raw.on("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
        if (!query || typeof query.language !== "string") {
            reply.code(400);
            return { error: 'Missing or invalid "query" in request body' };
        }
        try {
            assertExecutable(connectionStore.getConfig(id), query);
            const conn = await connectionStore.getLive(id);
            return await conn.execute(query, controller.signal);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.delete("/api/connections/:id/tables/:table/records", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema, primaryKey } = req.body as { schema?: string; primaryKey: Record<string, unknown> };
        try {
            assertWritable(connectionStore.getConfig(id));
            const conn = await connectionStore.getLive(id);
            await conn.deleteRow(table, schema, primaryKey);
            tableEvents.publish(id, table, { type: "delete", primaryKey });
            reply.code(204);
        } catch (err) {
            return sendError(reply, err);
        }
    });

    app.patch("/api/connections/:id/tables/:table/cell", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema, primaryKey, column, value } = req.body as {
            schema?: string;
            primaryKey: Record<string, unknown>;
            column: string;
            value: unknown;
        };
        try {
            assertWritable(connectionStore.getConfig(id));
            const conn = await connectionStore.getLive(id);
            await conn.updateCell(table, schema, primaryKey, column, value);
            tableEvents.publish(id, table, { type: "update", primaryKey, column, value });
            return { ok: true };
        } catch (err) {
            return sendError(reply, err);
        }
    });
}
