import type { FastifyInstance } from "fastify";
import { tableEvents, ensureNativeWatch, releaseNativeWatch } from "../table-events.js";

/**
 * Client connects to /ws/connections/:id/tables/:table/watch and receives
 * every insert/update/delete published for that table. This is the
 * internal/authenticated-equivalent channel — it exposes the raw
 * connectionId and table name in the URL, which is fine for the app's own
 * UI (same trust level as every other internal API route) but must never
 * be reachable from a public embed view. See routes/public-watch.ts for
 * that channel's token-gated, connection-detail-hiding equivalent.
 */
export async function watchRoutes(app: FastifyInstance) {
  app.get("/ws/connections/:id/tables/:table/watch", { websocket: true }, async (socket, req) => {
    const { id, table } = req.params as { id: string; table: string };

    try {
      await ensureNativeWatch(id, table);

      const unsubscribe = tableEvents.subscribe(id, table, (event) => {
        try {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
        } catch (err) {
          app.log.error({ err, connectionId: id, table }, "Failed to send table-watch event");
        }
      });

      const cleanup = () => {
        unsubscribe();
        releaseNativeWatch(id, table);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    } catch (err) {
      app.log.error({ err, connectionId: id, table }, "Failed to set up table watch");
      socket.close(1011, "Failed to set up table watch");
    }
  });
}
