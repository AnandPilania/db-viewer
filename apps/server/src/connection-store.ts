import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ConnectionConfig, DriverConnection } from "@pilaniaanand/driver-interface";
import { registry } from "./registry.js";
import { encrypt, decrypt, DATA_DIR } from "./crypto.js";

const STORE_PATH = path.join(DATA_DIR, "connections.json");

interface StoredConnection {
    config: ConnectionConfig; // in-memory copy has plaintext password
    live?: DriverConnection;
}

/** On-disk shape: password is encrypted, everything else is plain. */
type PersistedConfig = Omit<ConnectionConfig, "password"> & { encryptedPassword?: string };

/**
 * NOTE on production hardening: the encryption key itself lives on the same
 * disk as the ciphertext (see crypto.ts) — fine for a local dev tool, not
 * fine for a shared server. A real deployment should source the key from an
 * OS keychain or secrets manager instead.
 */
class ConnectionStore {
    private connections = new Map<string, StoredConnection>();

    constructor() {
        this.loadFromDisk();
    }

    private loadFromDisk() {
        if (!fs.existsSync(STORE_PATH)) return;
        try {
            const raw: PersistedConfig[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            for (const p of raw) {
                const { encryptedPassword, ...rest } = p;
                const config: ConnectionConfig = {
                    ...rest,
                    password: encryptedPassword ? decrypt(encryptedPassword) : undefined,
                };
                this.connections.set(config.id, { config });
            }
        } catch (err) {
            console.error("Failed to load persisted connections:", err);
        }
    }

    private saveToDisk() {
        const persisted: PersistedConfig[] = [...this.connections.values()].map(({ config }) => {
            const { password, ...rest } = config;
            return { ...rest, encryptedPassword: password ? encrypt(password) : undefined };
        });
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    }

    async create(input: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig> {
        const id = nanoid();
        const config: ConnectionConfig = { ...input, id };
        const driver = registry.get(config.driver);
        const test = await driver.testConnection(config);
        if (!test.ok) {
            throw new Error(test.message ?? "Connection test failed");
        }
        this.connections.set(id, { config });
        this.saveToDisk();
        return config;
    }

    list(): ConnectionConfig[] {
        return [...this.connections.values()].map((c) => redact(c.config));
    }

    getConfig(id: string): ConnectionConfig {
        const entry = this.connections.get(id);
        if (!entry) throw new Error(`Unknown connection "${id}"`);
        return entry.config;
    }

    async getLive(id: string): Promise<DriverConnection> {
        const entry = this.connections.get(id);
        if (!entry) throw new Error(`Unknown connection "${id}"`);
        if (!entry.live) {
            const driver = registry.get(entry.config.driver);
            entry.live = await driver.connect(entry.config);
        }
        return entry.live;
    }

    async remove(id: string): Promise<void> {
        const entry = this.connections.get(id);
        if (!entry) return;
        if (entry.live) await entry.live.close();
        this.connections.delete(id);
        this.saveToDisk();
    }

    /** Closes every currently-open driver connection without deleting the saved configs. Used on graceful shutdown. */
    async closeAll(): Promise<void> {
        const closes = [...this.connections.values()]
            .filter((entry) => entry.live)
            .map((entry) => entry.live!.close().catch(() => { }));
        await Promise.all(closes);
    }
}

function redact(config: ConnectionConfig): ConnectionConfig {
    return { ...config, password: config.password ? "••••••••" : undefined };
}

export const connectionStore = new ConnectionStore();
