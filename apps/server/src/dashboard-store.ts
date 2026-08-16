import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./crypto.js";
import type { Dashboard, DashboardLayoutItem } from "./models.js";

const STORE_PATH = path.join(DATA_DIR, "dashboards.json");

class DashboardStore {
  private dashboards = new Map<string, Dashboard>();

  constructor() {
    if (!fs.existsSync(STORE_PATH)) return;
    try {
      const raw: Dashboard[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      for (const d of raw) this.dashboards.set(d.id, d);
    } catch (err) {
      console.error("Failed to load persisted dashboards:", err);
    }
  }

  private save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...this.dashboards.values()], null, 2));
  }

  create(title: string): Dashboard {
    const dashboard: Dashboard = {
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

  get(id: string): Dashboard {
    const d = this.dashboards.get(id);
    if (!d) throw new Error(`Unknown dashboard "${id}"`);
    return d;
  }

  list(): Dashboard[] {
    return [...this.dashboards.values()];
  }

  updateTitle(id: string, title: string): Dashboard {
    const d = this.get(id);
    d.title = title;
    this.save();
    return d;
  }

  updateLayout(id: string, layout: DashboardLayoutItem[]): Dashboard {
    const d = this.get(id);
    d.layout = layout;
    this.save();
    return d;
  }

  /** Toggling embedding on (re)generates the share token, so disabling-then-enabling revokes any previously shared link. */
  setEmbedEnabled(id: string, enabled: boolean): Dashboard {
    const d = this.get(id);
    d.embedEnabled = enabled;
    d.shareToken = enabled ? crypto.randomBytes(24).toString("hex") : null;
    this.save();
    return d;
  }

  remove(id: string) {
    this.dashboards.delete(id);
    this.save();
  }
}

export const dashboardStore = new DashboardStore();
