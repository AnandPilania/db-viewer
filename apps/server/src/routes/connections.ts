import type { FastifyInstance } from "fastify";
import type { ExecSpec } from "@pilaniaanand/driver-interface";
import { connectionStore } from "../connection-store.js";
import { registry } from "../registry.js";
import { tableEvents } from "../table-events.js";
import { assertWritable, assertExecutable, ReadOnlyError } from "../read-only.js";

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
                sort: body.sort,
                pageSize: body.pageSize ?? 100,
                afterCursor: body.afterCursor ?? null,
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

    app.post("/api/connections/:id/tables/:table/records", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema, values } = req.body as { schema?: string; values: Record<string, unknown> };
        try {
            assertWritable(connectionStore.getConfig(id));
            const conn = await connectionStore.getLive(id);
            const inserted = await conn.insertRow(table, schema, values);
            tableEvents.publish(id, table, { type: "insert", row: inserted });
            reply.code(201);
            return inserted;
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
