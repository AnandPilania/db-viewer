import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./crypto.js";
import { logger } from "./logger.js";
const STORE_PATH = path.join(DATA_DIR, "widgets.json");
class WidgetStore {
    widgets = new Map();
    constructor() {
        if (!fs.existsSync(STORE_PATH))
            return;
        try {
            const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            for (const w of raw)
                this.widgets.set(w.id, w);
        }
        catch (err) {
            logger.error({ err }, "Failed to load persisted widgets");
        }
    }
    save() {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify([...this.widgets.values()], null, 2));
    }
    create(input) {
        const widget = { ...input, id: nanoid(), createdAt: new Date().toISOString() };
        this.widgets.set(widget.id, widget);
        this.save();
        return widget;
    }
    update(id, patch) {
        const existing = this.widgets.get(id);
        if (!existing)
            throw new Error(`Unknown widget "${id}"`);
        const updated = { ...existing, ...patch };
        this.widgets.set(id, updated);
        this.save();
        return updated;
    }
    get(id) {
        const w = this.widgets.get(id);
        if (!w)
            throw new Error(`Unknown widget "${id}"`);
        return w;
    }
    list() {
        return [...this.widgets.values()];
    }
    remove(id) {
        this.widgets.delete(id);
        this.save();
    }
}
export const widgetStore = new WidgetStore();
//# sourceMappingURL=widget-store.js.map