import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./crypto.js";
import { logger } from "./logger.js";
const STORE_PATH = path.join(DATA_DIR, "dashboards.json");
/** Days a new embed token stays valid. 0 disables expiry, for a permanently embedded dashboard. */
const DEFAULT_TOKEN_TTL_DAYS = 30;
function tokenExpiry() {
    const raw = process.env.DB_VIEWER_EMBED_TOKEN_TTL_DAYS;
    const days = raw === undefined ? DEFAULT_TOKEN_TTL_DAYS : Number(raw);
    if (!Number.isFinite(days) || days <= 0)
        return null;
    return new Date(Date.now() + days * 86_400_000).toISOString();
}
class DashboardStore {
    dashboards = new Map();
    constructor() {
        if (!fs.existsSync(STORE_PATH))
            return;
        try {
            const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            for (const d of raw)
                this.dashboards.set(d.id, d);
        }
        catch (err) {
            logger.error({ err }, "Failed to load persisted dashboards");
        }
    }
    save() {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify([...this.dashboards.values()], null, 2));
    }
    create(title) {
        const dashboard = {
            id: nanoid(),
            title,
            layout: [],
            embedEnabled: false,
            shareToken: null,
            createdAt: new Date().toISOString(),
        };
        this.dashboards.set(dashboard.id, dashboard);
        this.save();
        return dashboard;
    }
    get(id) {
        const d = this.dashboards.get(id);
        if (!d)
            throw new Error(`Unknown dashboard "${id}"`);
        return d;
    }
    list() {
        return [...this.dashboards.values()];
    }
    updateTitle(id, title) {
        const d = this.get(id);
        d.title = title;
        this.save();
        return d;
    }
    updateLayout(id, layout) {
        const d = this.get(id);
        d.layout = layout;
        this.save();
        return d;
    }
    /** Toggling embedding on (re)generates the share token, so disabling-then-enabling revokes any previously shared link. */
    setEmbedEnabled(id, enabled) {
        const d = this.get(id);
        d.embedEnabled = enabled;
        if (enabled)
            return this.issueToken(d);
        d.shareToken = null;
        d.shareTokenExpiresAt = null;
        this.save();
        return d;
    }
    /**
     * Issues a fresh token and invalidates the previous one immediately. This
     * is the revocation path: a link that leaked into a wiki, a chat, or a
     * browser history stops working the moment this is called.
     */
    rotateShareToken(id) {
        const d = this.get(id);
        if (!d.embedEnabled)
            throw new Error("Embedding is not enabled for this dashboard");
        return this.issueToken(d);
    }
    issueToken(d) {
        d.shareToken = crypto.randomBytes(24).toString("hex");
        d.shareTokenExpiresAt = tokenExpiry();
        this.save();
        return d;
    }
    remove(id) {
        this.dashboards.delete(id);
        this.save();
    }
}
export const dashboardStore = new DashboardStore();
//# sourceMappingURL=dashboard-store.js.map