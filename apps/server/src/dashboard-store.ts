import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./crypto.js";
import { logger } from "./logger.js";
import type { Dashboard, DashboardLayoutItem } from "./models.js";

const STORE_PATH = path.join(DATA_DIR, "dashboards.json");

/** Days a new embed token stays valid. 0 disables expiry, for a permanently embedded dashboard. */
const DEFAULT_TOKEN_TTL_DAYS = 30;

function tokenExpiry(): string | null {
  const raw = process.env.DB_VIEWER_EMBED_TOKEN_TTL_DAYS;
  const days = raw === undefined ? DEFAULT_TOKEN_TTL_DAYS : Number(raw);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

class DashboardStore {
  private dashboards = new Map<string, Dashboard>();

  constructor() {
    if (!fs.existsSync(STORE_PATH)) return;
    try {
      const raw: Dashboard[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      for (const d of raw) this.dashboards.set(d.id, d);
    } catch (err) {
      logger.error({ err }, "Failed to load persisted dashboards");
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
    if (enabled) return this.issueToken(d);
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
  rotateShareToken(id: string): Dashboard {
    const d = this.get(id);
    if (!d.embedEnabled) throw new Error("Embedding is not enabled for this dashboard");
    return this.issueToken(d);
  }

  private issueToken(d: Dashboard): Dashboard {
    d.shareToken = crypto.randomBytes(24).toString("hex");
    d.shareTokenExpiresAt = tokenExpiry();
    this.save();
    return d;
  }

  remove(id: string) {
    this.dashboards.delete(id);
    this.save();
  }
}

export const dashboardStore = new DashboardStore();
