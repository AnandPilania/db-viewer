import type { FastifyInstance } from "fastify";
import { connectionStore } from "../connection-store.js";
import { registry } from "../registry.js";

export async function connectionRoutes(app: FastifyInstance) {
  app.get("/api/drivers", async () => registry.list());

  app.get("/api/connections", async () => connectionStore.list());

  app.post("/api/connections", async (req, reply) => {
    const body = req.body as any;
    try {
      const config = await connectionStore.create(body);
      return { ...config, password: config.password ? "••••••••" : undefined };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
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
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/connections/:id/tables", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { schema } = req.query as { schema?: string };
    try {
      const conn = await connectionStore.getLive(id);
      return await conn.listTables(schema);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/connections/:id/tables/:table", async (req, reply) => {
    const { id, table } = req.params as { id: string; table: string };
    const { schema } = req.query as { schema?: string };
    try {
      const conn = await connectionStore.getLive(id);
      return await conn.describeTable(table, schema);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post("/api/connections/:id/tables/:table/rows", async (req, reply) => {
    const { id, table } = req.params as { id: string; table: string };
    const body = (req.body as any) ?? {};
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
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
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/connections/:id/tables/:table/count/estimate", async (req, reply) => {
    const { id, table } = req.params as { id: string; table: string };
    const { schema } = req.query as { schema?: string };
    try {
      const conn = await connectionStore.getLive(id);
      return await conn.estimateRowCount(table, schema);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get("/api/connections/:id/tables/:table/count/exact", async (req, reply) => {
    const { id, table } = req.params as { id: string; table: string };
    const { schema } = req.query as { schema?: string };
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
    try {
      const conn = await connectionStore.getLive(id);
      return await conn.countRowsExact(table, schema, controller.signal);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post("/api/connections/:id/execute", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sql, params } = req.body as { sql: string; params?: unknown[] };
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
    try {
      const conn = await connectionStore.getLive(id);
      return await conn.execute(sql, params, controller.signal);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
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
      const conn = await connectionStore.getLive(id);
      await conn.updateCell(table, schema, primaryKey, column, value);
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
