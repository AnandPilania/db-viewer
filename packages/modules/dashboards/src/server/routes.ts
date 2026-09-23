import crypto from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
// Side-effect import: brings in @fastify/websocket's module augmentation
// (the `websocket: true` route option, and the socket param on the handler)
// — the app registers the plugin itself; this package only needs the types.
import "@fastify/websocket";
import { jwtVerify } from "jose";
import type { ConnectionConfig, DriverConnection, RowChangeEvent } from "@pilaniaanand/driver-interface";
import { dashboardStore } from "./dashboard-store.js";
import { widgetStore } from "./widget-store.js";
import { fetchWidgetData } from "./chart-query.js";
import { validateWidgetInput, validateWidgetPatch, SAFE_CSS_COLOR } from "./widget-validation.js";
import type { DashboardAnnotation, DashboardLayoutItem, DashboardParameter } from "./models.js";
import { nanoid } from "nanoid";

/** Same trust boundary as widget-validation's highlightRules — a color string lands in a style attribute client-side. */
function validateAnnotations(raw: unknown): DashboardAnnotation[] {
    if (!Array.isArray(raw)) throw new Error("annotations must be an array");
    return raw.map((a, i) => {
        const entry = a as Record<string, unknown>;
        const date = entry.date;
        if (typeof date !== "string" || !date) throw new Error(`annotations[${i}].date is required`);
        const label = entry.label;
        if (typeof label !== "string" || !label.trim()) throw new Error(`annotations[${i}].label is required`);
        const color = entry.color;
        if (color !== undefined && (typeof color !== "string" || !SAFE_CSS_COLOR.test(color))) {
            throw new Error(`annotations[${i}].color is not a valid CSS color`);
        }
        const id = typeof entry.id === "string" && entry.id ? entry.id : nanoid();
        return { id, date, label: label.trim().slice(0, 200), color };
    });
}

/**
 * Everything this plugin needs from the host app, passed in as registration
 * options rather than imported directly — so this package has no dependency
 * back on the app hosting it (see apps/server/src/index.ts, which registers
 * this plugin with its own connectionStore/tableEvents).
 */
export interface DashboardModuleRouteOptions {
    connectionStore: {
        getConfig(id: string): ConnectionConfig;
        getLive(id: string): Promise<DriverConnection>;
    };
    tableEvents: {
        subscribe(connectionId: string, table: string, handler: (event: RowChangeEvent) => void): () => void;
    };
    ensureNativeWatch: (connectionId: string, table: string) => Promise<void>;
    releaseNativeWatch: (connectionId: string, table: string) => void;
}

/**
 * No session/auth beyond the share token. This is the trust boundary: the
 * public routes that call this only ever replay a widget's PRE-SAVED query
 * (built and validated server-side when the widget was created) — they
 * accept no free-form SQL, table, or column input from the caller. An
 * embed link can only show what its creator configured, nothing else.
 */
/** Constant-time compare so a wrong token leaks nothing through response timing. */
function tokenMatches(supplied: string | undefined, expected: string): boolean {
    if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

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
 * Cheap shape check — three dot-separated base64url segments — used only to
 * decide which verifier to try, not to parse the token. A real signature/
 * expiry/claim check happens in authorizeSignedEmbed itself.
 */
function isJwtShaped(token: string): boolean {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export interface SignedEmbedResult {
    ok: true;
    /** Verified from the token's `params` claim — see mint example below. */
    params: Record<string, unknown>;
    /** Param names the token's params can't be overridden for by the request's own `?params=`. */
    locked: string[];
}

/**
 * Second, signed embed mode alongside the opaque `shareToken` above. A host
 * app mints its own JWT server-side (any stack — no SDK from this repo, see
 * Part C of the plan), e.g. in Node with `jose`:
 *
 *   import { SignJWT } from "jose";
 *   const jwt = await new SignJWT({ params: { user_id: 123 }, locked: ["user_id"] })
 *     .setProtectedHeader({ alg: "HS256" })
 *     .setSubject(dashboardId)
 *     .setExpirationTime("1h")
 *     .setIssuedAt()
 *     .sign(new TextEncoder().encode(embedSecret));
 *   // then include `{ dashboardId, ...}` as a top-level claim (see payload
 *   // shape below) — SignJWT's setSubject is not what's checked here.
 *
 * Verifies signature + expiry (jose rejects an expired `exp` automatically)
 * + that the token's own `dashboardId` claim matches the dashboard being
 * requested, so a token minted for dashboard A can't be replayed against B.
 * Rejects the same way (status/shape) as an invalid opaque token.
 */
export async function authorizeSignedEmbed(
    dashboardId: string,
    token: string
): Promise<SignedEmbedResult | { ok: false; status: number; error: string }> {
    let dashboard;
    try {
        dashboard = dashboardStore.get(dashboardId);
    } catch {
        return { ok: false, status: 404, error: "Dashboard not found" };
    }
    if (!dashboard.embedEnabled || !dashboard.embedSecret) {
        return { ok: false, status: 403, error: "Embedding is not enabled for this dashboard" };
    }
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(dashboard.embedSecret));
        if (payload.dashboardId !== dashboardId) {
            return { ok: false, status: 403, error: "Invalid or missing embed token" };
        }
        return {
            ok: true,
            params: (payload.params as Record<string, unknown> | undefined) ?? {},
            locked: (payload.locked as string[] | undefined) ?? [],
        };
    } catch {
        // Bad signature, expired, malformed — all indistinguishable from the
        // caller's point of view, same as a wrong opaque token.
        return { ok: false, status: 403, error: "Invalid or missing embed token" };
    }
}

/**
 * Picks the opaque or signed verifier by the token's shape, so both embed
 * modes keep working side by side through the same public routes. Returns
 * a uniform shape either way: an opaque-token success carries no
 * params/locked (full, unrestricted filter bar — today's behavior).
 */
async function authorizeAndResolveEmbed(
    dashboardId: string,
    token: string | undefined
): Promise<SignedEmbedResult | { ok: false; status: number; error: string }> {
    if (token && isJwtShaped(token)) {
        return authorizeSignedEmbed(dashboardId, token);
    }
    const auth = authorizeEmbed(dashboardId, token);
    if (!auth.ok) return auth;
    return { ok: true, params: {}, locked: [] };
}

/**
 * Merges the token's verified params with the request's own `?params=` — the
 * viewer's filter-bar adjustments. Locked names always take the token's
 * value regardless of what the request supplied (the security property:
 * the host app, not the viewer, controls those). Unlocked token params act
 * as defaults the request can override.
 */
function mergeEmbedParams(
    auth: SignedEmbedResult,
    requestParams: Record<string, unknown>
): Record<string, unknown> {
    const merged = { ...auth.params, ...requestParams };
    for (const name of auth.locked) {
        if (name in auth.params) merged[name] = auth.params[name];
    }
    return merged;
}

function parseParamsQuery(raw: string | undefined): Record<string, unknown> | { error: string } {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return { error: "params must be a JSON object" };
    }
}

export default fp<DashboardModuleRouteOptions>(async function dashboardModuleRoutes(app: FastifyInstance, opts) {
    const { connectionStore, tableEvents, ensureNativeWatch, releaseNativeWatch } = opts;

    /**
     * A dashboard mixing widgets from several connections is fine (Metabase/
     * Grafana/Superset all do it — each card is independently sourced, nothing
     * joins across connections) EXCEPT that an embedded dashboard's share token
     * grants read access to every connection its widgets touch. So mixing is
     * only allowed when every connection involved has opted in via
     * `allowMultiDbDashboards`; a dashboard whose widgets all share one
     * connection is unaffected either way.
     */
    function assertConnectionsAllowMixing(dashboardTitle: string, layout: DashboardLayoutItem[]) {
        const connectionIds = new Set<string>();
        for (const item of layout) {
            try {
                const widget = widgetStore.get(item.widgetId);
                if (widget.connectionId) connectionIds.add(widget.connectionId); // text widgets (B5) have none
            } catch {
                // Dangling widget id — ignored here, same as elsewhere in this file.
            }
        }
        if (connectionIds.size <= 1) return;
        for (const id of connectionIds) {
            const config = connectionStore.getConfig(id);
            if (!config.allowMultiDbDashboards) {
                // Same fallback WidgetForm's connection picker uses: a server
                // connection is named by its database, a file-based one (sqlite)
                // by its file's basename — the id alone means nothing to a viewer.
                const name = config.database || config.filePath?.split(/[/\\]/).pop() || id;
                throw new Error(
                    `Dashboard "${dashboardTitle}" mixes multiple connections, but "${name}" hasn't opted into multi-database dashboards. Enable it on the connection, or keep this dashboard to widgets from one connection.`
                );
            }
        }
    }

    // --- Dashboards ---

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
        const body = req.body as {
            title?: string;
            layout?: DashboardLayoutItem[];
            parameters?: DashboardParameter[];
            folder?: string;
            annotations?: unknown;
        };
        try {
            if (body.title !== undefined) dashboardStore.updateTitle(id, body.title);
            if (body.layout !== undefined) {
                assertConnectionsAllowMixing(dashboardStore.get(id).title, body.layout);
                dashboardStore.updateLayout(id, body.layout);
            }
            if (body.parameters !== undefined) dashboardStore.updateParameters(id, body.parameters);
            if (body.folder !== undefined) dashboardStore.updateFolder(id, body.folder);
            if (body.annotations !== undefined) dashboardStore.updateAnnotations(id, validateAnnotations(body.annotations));
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

    app.post("/api/dashboards/:id/embed/rotate", async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
            return dashboardStore.rotateShareToken(id);
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
        // Token-gated data reached via a URL: keep it out of shared and browser caches.
        reply.header("Cache-Control", "no-store");
        const auth = await authorizeAndResolveEmbed(id, token);
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
                } catch {
                    return null;
                }
            })
            .filter((w): w is NonNullable<typeof w> => w !== null);
        // Locked params (signed-embed mode) render no control at all on the
        // embed page — an opaque-token auth carries an empty `locked` list,
        // so this is every parameter, same as today's unrestricted behavior.
        const parameters = (dashboard.parameters ?? []).filter((p) => !auth.locked.includes(p.name));
        return { id: dashboard.id, title: dashboard.title, widgets, parameters };
    });

    app.get("/api/public/dashboards/:id/widgets/:widgetId/data", async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        const { id, widgetId } = req.params as { id: string; widgetId: string };
        const { token, params: paramsRaw } = req.query as { token?: string; params?: string };
        const auth = await authorizeAndResolveEmbed(id, token);
        if (!auth.ok) {
            reply.code(auth.status);
            return { error: auth.error };
        }
        const requestParams = parseParamsQuery(paramsRaw);
        if ("error" in requestParams) {
            reply.code(400);
            return requestParams;
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
            return await fetchWidgetData(conn, config, widget, mergeEmbedParams(auth, requestParams));
        } catch (err) {
            reply.code(400);
            return { error: (err as Error).message };
        }
    });

    // --- Widgets ---

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
        const { params: paramsRaw } = req.query as { params?: string };
        let dashboardParams: Record<string, unknown> = {};
        if (paramsRaw) {
            try {
                dashboardParams = JSON.parse(paramsRaw);
            } catch {
                reply.code(400);
                return { error: "params must be a JSON object" };
            }
        }
        try {
            const widget = widgetStore.get(id);
            if (widget.kind === "text") {
                reply.code(400);
                return { error: "Text widgets have no data" };
            }
            const conn = await connectionStore.getLive(widget.connectionId);
            const config = connectionStore.getConfig(widget.connectionId);
            return await fetchWidgetData(conn, config, widget, dashboardParams);
        } catch (err) {
            reply.code(400);
            return { error: (err as Error).message };
        }
    });

    // --- Public watch (websocket) ---
    // Public equivalent of /ws/connections/:id/tables/:table/watch — but this
    // one is reachable from an embedded page on any external site, so it must
    // not leak the same information. It:
    //  - requires the dashboard's share token, same as the other public routes
    //  - never sends the raw row payload, only a content-free "changed" ping —
    //    the client already has a safe, pre-scoped way to fetch the actual
    //    data (the public widget-data endpoint), so there's no reason to also
    //    push raw row contents over this channel
    //  - never exposes which connectionId/table the widget reads from; that
    //    stays server-side

    app.get("/ws/public/dashboards/:id/widgets/:widgetId/watch", { websocket: true }, async (socket, req) => {
        const { id, widgetId } = req.params as { id: string; widgetId: string };
        const { token } = req.query as { token?: string };

        const auth = await authorizeAndResolveEmbed(id, token);
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

            // An errored socket fires 'error' *and then* 'close', so an unguarded
            // cleanup released the refcount twice — dropping it to zero while other
            // tabs were still watching, which silently stopped their native watcher.
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
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
});
