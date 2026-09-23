import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./data-dir.js";
import type { Dashboard, DashboardAnnotation, DashboardLayoutItem, DashboardParameter } from "./models.js";

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
      // ponytail: corrupt-persisted-file is a rare edge case; console.error
      // rather than threading the app's daily-rotating logger in as a plugin
      // option just for this one path. Wire it in if this ever needs to land
      // in the same log file.
      console.error("Failed to load persisted dashboards", err);
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
      parameters: [],
      annotations: [],
      embedEnabled: false,
      shareToken: null,
      embedSecret: null,
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

  updateParameters(id: string, parameters: DashboardParameter[]): Dashboard {
    const d = this.get(id);
    d.parameters = parameters;
    this.save();
    return d;
  }

  /** Empty string clears the folder (ungrouped) rather than storing a blank tag. */
  updateFolder(id: string, folder: string): Dashboard {
    const d = this.get(id);
    d.folder = folder.trim() || undefined;
    this.save();
    return d;
  }

  updateAnnotations(id: string, annotations: DashboardAnnotation[]): Dashboard {
    const d = this.get(id);
    d.annotations = annotations;
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
    d.embedSecret = null;
    this.save();
    return d;
  }

  /**
   * Issues a fresh token (and embed secret) and invalidates the previous
   * ones immediately. This is the revocation path: a link — or a signed
   * embed integration — that leaked stops working the moment this is
   * called. Both are rotated together since they share one lifecycle;
   * nothing today needs to rotate the secret independently of the token.
   */
  rotateShareToken(id: string): Dashboard {
    const d = this.get(id);
    if (!d.embedEnabled) throw new Error("Embedding is not enabled for this dashboard");
    return this.issueToken(d);
  }

  private issueToken(d: Dashboard): Dashboard {
    d.shareToken = crypto.randomBytes(24).toString("hex");
    d.shareTokenExpiresAt = tokenExpiry();
    d.embedSecret = crypto.randomBytes(32).toString("hex");
    this.save();
    return d;
  }

  remove(id: string) {
    this.dashboards.delete(id);
    this.save();
  }
}

export const dashboardStore = new DashboardStore();
