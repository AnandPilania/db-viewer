import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./crypto.js";
import type { Widget } from "./models.js";

const STORE_PATH = path.join(DATA_DIR, "widgets.json");

class WidgetStore {
  private widgets = new Map<string, Widget>();

  constructor() {
    if (!fs.existsSync(STORE_PATH)) return;
    try {
      const raw: Widget[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      for (const w of raw) this.widgets.set(w.id, w);
    } catch (err) {
      console.error("Failed to load persisted widgets:", err);
    }
  }

  private save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...this.widgets.values()], null, 2));
  }

  create(input: Omit<Widget, "id" | "createdAt">): Widget {
    const widget: Widget = { ...input, id: nanoid(), createdAt: new Date().toISOString() };
    this.widgets.set(widget.id, widget);
    this.save();
    return widget;
  }

  update(id: string, patch: Partial<Omit<Widget, "id" | "createdAt">>): Widget {
    const existing = this.widgets.get(id);
    if (!existing) throw new Error(`Unknown widget "${id}"`);
    const updated = { ...existing, ...patch };
    this.widgets.set(id, updated);
    this.save();
    return updated;
  }

  get(id: string): Widget {
    const w = this.widgets.get(id);
    if (!w) throw new Error(`Unknown widget "${id}"`);
    return w;
  }

  list(): Widget[] {
    return [...this.widgets.values()];
  }

  remove(id: string) {
    this.widgets.delete(id);
    this.save();
  }
}

export const widgetStore = new WidgetStore();
