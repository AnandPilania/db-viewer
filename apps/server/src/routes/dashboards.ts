import type { FastifyInstance } from "fastify";
import { dashboardStore } from "../dashboard-store.js";
import { widgetStore } from "../widget-store.js";
import { connectionStore } from "../connection-store.js";
import { fetchWidgetData } from "../chart-query.js";
import type { DashboardLayoutItem } from "../models.js";

/**
 * No session/auth beyond the share token. This is the trust boundary: the
 * public routes that call this only ever replay a widget's PRE-SAVED query
 * (built and validated server-side when the widget was created) — they
 * accept no free-form SQL, table, or column input from the caller. An
 * embed link can only show what its creator configured, nothing else.
 */
export function authorizeEmbed(
  dashboardId: string,
  token: string | undefined
): { ok: true } | { ok: false; status: number; error: string } {
  let dashboard;
  try {
    dashboard = dashboardStore.get(dashboardId);
  } catch {
    return { ok: false, status: 404, error: "Dashboard not found" };
  }
  if (!dashboard.embedEnabled || !dashboard.shareToken) {
    return { ok: false, status: 403, error: "Embedding is not enabled for this dashboard" };
  }
  if (token !== dashboard.shareToken) {
    return { ok: false, status: 403, error: "Invalid or missing embed token" };
  }
  return { ok: true };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboards", async () => dashboardStore.list());

  app.post("/api/dashboards", async (req, reply) => {
    const { title } = req.body as { title: string };
    if (!title?.trim()) {
      reply.code(400);
      return { error: "title is required" };
    }
    return dashboardStore.create(title);
  });

  app.get("/api/dashboards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return dashboardStore.get(id);
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  app.patch("/api/dashboards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: string; layout?: DashboardLayoutItem[] };
    try {
      if (body.title !== undefined) dashboardStore.updateTitle(id, body.title);
      if (body.layout !== undefined) dashboardStore.updateLayout(id, body.layout);
      return dashboardStore.get(id);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.delete("/api/dashboards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    dashboardStore.remove(id);
    reply.code(204);
  });

  app.post("/api/dashboards/:id/embed", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = req.body as { enabled: boolean };
    try {
      return dashboardStore.setEmbedEnabled(id, enabled);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // --- Public embed endpoints ---
  // See authorizeEmbed() above for the trust-boundary rationale.

  app.get("/api/public/dashboards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { token } = req.query as { token?: string };
    const auth = authorizeEmbed(id, token);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const dashboard = dashboardStore.get(id);
    const widgets = dashboard.layout
      .map((item) => {
        try {
          const w = widgetStore.get(item.widgetId);
          // Strip connection details from the public payload — the client
          // never needs (or gets) connectionId/schema/table, only what's
          // needed to render the chart shell before data arrives.
          return { id: w.id, title: w.title, chartType: w.chartType, layout: item };
        } catch {
          return null;
        }
      })
      .filter((w): w is NonNullable<typeof w> => w !== null);
    return { id: dashboard.id, title: dashboard.title, widgets };
  });

  app.get("/api/public/dashboards/:id/widgets/:widgetId/data", async (req, reply) => {
    const { id, widgetId } = req.params as { id: string; widgetId: string };
    const { token } = req.query as { token?: string };
    const auth = authorizeEmbed(id, token);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const dashboard = dashboardStore.get(id);
    if (!dashboard.layout.some((item) => item.widgetId === widgetId)) {
      reply.code(404);
      return { error: "Widget is not on this dashboard" };
    }
    try {
      const widget = widgetStore.get(widgetId);
      const conn = await connectionStore.getLive(widget.connectionId);
      const config = connectionStore.getConfig(widget.connectionId);
      return await fetchWidgetData(conn, config, widget);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
