import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./crypto.js";
import { logger } from "./logger.js";
const STORE_PATH = path.join(DATA_DIR, "dashboards.json");
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
        d.shareToken = enabled ? crypto.randomBytes(24).toString("hex") : null;
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