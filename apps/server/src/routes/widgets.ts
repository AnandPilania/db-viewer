import type { FastifyInstance } from "fastify";
import { widgetStore } from "../widget-store.js";
import { connectionStore } from "../connection-store.js";
import { fetchWidgetData } from "../chart-query.js";
import { validateWidgetInput, validateWidgetPatch } from "../widget-validation.js";

export async function widgetRoutes(app: FastifyInstance) {
  app.get("/api/widgets", async () => widgetStore.list());

  app.post("/api/widgets", async (req, reply) => {
    try {
      return widgetStore.create(validateWidgetInput(req.body));
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.patch("/api/widgets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return widgetStore.update(id, validateWidgetPatch(widgetStore.get(id), req.body));
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.delete("/api/widgets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    widgetStore.remove(id);
    reply.code(204);
  });

  app.get("/api/widgets/:id/data", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const widget = widgetStore.get(id);
      const conn = await connectionStore.getLive(widget.connectionId);
      const config = connectionStore.getConfig(widget.connectionId);
      return await fetchWidgetData(conn, config, widget);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
