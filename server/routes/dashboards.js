import crypto from "node:crypto";
import { dashboardStore } from "../dashboard-store.js";
import { widgetStore } from "../widget-store.js";
import { connectionStore } from "../connection-store.js";
import { fetchWidgetData } from "../chart-query.js";
/**
 * No session/auth beyond the share token. This is the trust boundary: the
 * public routes that call this only ever replay a widget's PRE-SAVED query
 * (built and validated server-side when the widget was created) — they
 * accept no free-form SQL, table, or column input from the caller. An
 * embed link can only show what its creator configured, nothing else.
 */
/** Constant-time compare so a wrong token leaks nothing through response timing. */
function tokenMatches(supplied, expected) {
    if (typeof supplied !== "string" || supplied.length !== expected.length)
        return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
export function authorizeEmbed(dashboardId, token) {
    let dashboard;
    try {
        dashboard = dashboardStore.get(dashboardId);
    }
    catch {
        return { ok: false, status: 404, error: "Dashboard not found" };
    }
    if (!dashboard.embedEnabled || !dashboard.shareToken) {
        return { ok: false, status: 403, error: "Embedding is not enabled for this dashboard" };
    }
    if (!tokenMatches(token, dashboard.shareToken)) {
        return { ok: false, status: 403, error: "Invalid or missing embed token" };
    }
    // Checked after the token compare so an expiry message can't be used to
    // confirm that a guessed token was otherwise correct.
    if (dashboard.shareTokenExpiresAt && Date.parse(dashboard.shareTokenExpiresAt) < Date.now()) {
        return { ok: false, status: 403, error: "This embed link has expired — rotate the token to issue a new one" };
    }
    return { ok: true };
}
/**
 * A dashboard mixing widgets from several connections is fine (Metabase/
 * Grafana/Superset all do it — each card is independently sourced, nothing
 * joins across connections) EXCEPT that an embedded dashboard's share token
 * grants read access to every connection its widgets touch. So mixing is
 * only allowed when every connection involved has opted in via
 * `allowMultiDbDashboards`; a dashboard whose widgets all share one
 * connection is unaffected either way.
 */
function assertConnectionsAllowMixing(layout) {
    const connectionIds = new Set();
    for (const item of layout) {
        try {
            connectionIds.add(widgetStore.get(item.widgetId).connectionId);
        }
        catch {
            // Dangling widget id — ignored here, same as elsewhere in this file.
        }
    }
    if (connectionIds.size <= 1)
        return;
    for (const id of connectionIds) {
        if (!connectionStore.getConfig(id).allowMultiDbDashboards) {
            throw new Error(`This dashboard mixes multiple connections, but "${id}" hasn't opted into multi-database dashboards. Enable it on the connection, or keep this dashboard to widgets from one connection.`);
        }
    }
}
export async function dashboardRoutes(app) {
    app.get("/api/dashboards", async () => dashboardStore.list());
    app.post("/api/dashboards", async (req, reply) => {
        const { title } = req.body;
        if (!title?.trim()) {
            reply.code(400);
            return { error: "title is required" };
        }
        return dashboardStore.create(title);
    });
    app.get("/api/dashboards/:id", async (req, reply) => {
        const { id } = req.params;
        try {
            return dashboardStore.get(id);
        }
        catch (err) {
            reply.code(404);
            return { error: err.message };
        }
    });
    app.patch("/api/dashboards/:id", async (req, reply) => {
        const { id } = req.params;
        const body = req.body;
        try {
            if (body.title !== undefined)
                dashboardStore.updateTitle(id, body.title);
            if (body.layout !== undefined) {
                assertConnectionsAllowMixing(body.layout);
                dashboardStore.updateLayout(id, body.layout);
            }
            return dashboardStore.get(id);
        }
        catch (err) {
            reply.code(400);
            return { error: err.message };
        }
    });
    app.delete("/api/dashboards/:id", async (req, reply) => {
        const { id } = req.params;
        dashboardStore.remove(id);
        reply.code(204);
    });
    app.post("/api/dashboards/:id/embed", async (req, reply) => {
        const { id } = req.params;
        const { enabled } = req.body;
        try {
            return dashboardStore.setEmbedEnabled(id, enabled);
        }
        catch (err) {
            reply.code(400);
            return { error: err.message };
        }
    });
    app.post("/api/dashboards/:id/embed/rotate", async (req, reply) => {
        const { id } = req.params;
        try {
            return dashboardStore.rotateShareToken(id);
        }
        catch (err) {
            reply.code(400);
            return { error: err.message };
        }
    });
    // --- Public embed endpoints ---
    // See authorizeEmbed() above for the trust-boundary rationale.
    app.get("/api/public/dashboards/:id", async (req, reply) => {
        const { id } = req.params;
        const { token } = req.query;
        // Token-gated data reached via a URL: keep it out of shared and browser caches.
        reply.header("Cache-Control", "no-store");
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
                return { id: w.id, title: w.title, chartType: w.chartType, highlightRules: w.highlightRules, layout: item };
            }
            catch {
                return null;
            }
        })
            .filter((w) => w !== null);
        return { id: dashboard.id, title: dashboard.title, widgets };
    });
    app.get("/api/public/dashboards/:id/widgets/:widgetId/data", async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        const { id, widgetId } = req.params;
        const { token } = req.query;
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
        }
        catch (err) {
            reply.code(400);
            return { error: err.message };
        }
    });
}
//# sourceMappingURL=dashboards.js.map