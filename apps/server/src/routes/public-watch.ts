import type { FastifyInstance } from "fastify";
import { dashboardStore } from "../dashboard-store.js";
import { widgetStore } from "../widget-store.js";
import { tableEvents, ensureNativeWatch, releaseNativeWatch } from "../table-events.js";
import { authorizeEmbed } from "./dashboards.js";

/**
 * Public equivalent of /ws/connections/:id/tables/:table/watch — but this
 * one is reachable from an embedded page on any external site, so it must
 * not leak the same information. It:
 *  - requires the dashboard's share token, same as the other public routes
 *  - never sends the raw row payload, only a content-free "changed" ping —
 *    the client already has a safe, pre-scoped way to fetch the actual
 *    data (the public widget-data endpoint), so there's no reason to also
 *    push raw row contents over this channel
 *  - never exposes which connectionId/table the widget reads from; that
 *    stays server-side
 */
export async function publicWatchRoutes(app: FastifyInstance) {
  app.get("/ws/public/dashboards/:id/widgets/:widgetId/watch", { websocket: true }, async (socket, req) => {
    const { id, widgetId } = req.params as { id: string; widgetId: string };
    const { token } = req.query as { token?: string };

    const auth = authorizeEmbed(id, token);
    if (!auth.ok) {
      socket.close(1008, auth.error);
      return;
    }

    let dashboard, widget;
    try {
      dashboard = dashboardStore.get(id);
      widget = widgetStore.get(widgetId);
    } catch {
      socket.close(1008, "Dashboard or widget not found");
      return;
    }
    if (!dashboard.layout.some((item) => item.widgetId === widgetId)) {
      socket.close(1008, "Widget is not on this dashboard");
      return;
    }

    try {
      await ensureNativeWatch(widget.connectionId, widget.table);

      const unsubscribe = tableEvents.subscribe(widget.connectionId, widget.table, () => {
        try {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "changed" }));
        } catch (err) {
          app.log.error({ err, widgetId }, "Failed to send public-watch ping");
        }
      });

      const cleanup = () => {
        unsubscribe();
        releaseNativeWatch(widget.connectionId, widget.table);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    } catch (err) {
      app.log.error({ err, widgetId }, "Failed to set up public table watch");
      socket.close(1011, "Failed to set up table watch");
    }
  });
}
