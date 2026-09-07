import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ConnectionConfig, DriverConnection, SshTunnelConfig, SslConfig } from "@pilaniaanand/driver-interface";
import { registry } from "./registry.js";
import { encrypt, decrypt, DATA_DIR } from "./crypto.js";
import { openSshTunnel, type TunnelHandle } from "./ssh-tunnel.js";
import { logger } from "./logger.js";

const STORE_PATH = path.join(DATA_DIR, "connections.json");

interface StoredConnection {
    config: ConnectionConfig; // in-memory copy has plaintext password/keys
    live?: DriverConnection;
}

/** On-disk shape: every secret (password, TLS client key, SSH credentials) is encrypted, everything else is plain. */
type PersistedSsl = Omit<SslConfig, "key"> & { encryptedKey?: string };
type PersistedSshTunnel = Omit<SshTunnelConfig, "privateKey" | "passphrase" | "password"> & {
    encryptedPrivateKey?: string;
    encryptedPassphrase?: string;
    encryptedPassword?: string;
};
type PersistedConfig = Omit<ConnectionConfig, "password" | "ssl" | "sshTunnel"> & {
    encryptedPassword?: string;
    ssl?: boolean | PersistedSsl;
    sshTunnel?: PersistedSshTunnel;
};

function encodeConfig(config: ConnectionConfig): PersistedConfig {
    const { password, ssl, sshTunnel, ...rest } = config;
    const persisted: PersistedConfig = { ...rest, encryptedPassword: password ? encrypt(password) : undefined };

    if (typeof ssl === "boolean") persisted.ssl = ssl;
    else if (ssl) {
        const { key, ...sslRest } = ssl;
        persisted.ssl = { ...sslRest, encryptedKey: key ? encrypt(key) : undefined };
    }

    if (sshTunnel) {
        const { privateKey, passphrase, password: sshPassword, ...tunnelRest } = sshTunnel;
        persisted.sshTunnel = {
            ...tunnelRest,
            encryptedPrivateKey: privateKey ? encrypt(privateKey) : undefined,
            encryptedPassphrase: passphrase ? encrypt(passphrase) : undefined,
            encryptedPassword: sshPassword ? encrypt(sshPassword) : undefined,
        };
    }

    return persisted;
}

function decodeConfig(persisted: PersistedConfig): ConnectionConfig {
    const { encryptedPassword, ssl, sshTunnel, ...rest } = persisted;
    const config: ConnectionConfig = { ...rest, password: encryptedPassword ? decrypt(encryptedPassword) : undefined };

    if (typeof ssl === "boolean") config.ssl = ssl;
    else if (ssl) {
        const { encryptedKey, ...sslRest } = ssl;
        config.ssl = { ...sslRest, key: encryptedKey ? decrypt(encryptedKey) : undefined };
    }

    if (sshTunnel) {
        const { encryptedPrivateKey, encryptedPassphrase, encryptedPassword: encSshPassword, ...tunnelRest } = sshTunnel;
        config.sshTunnel = {
            ...tunnelRest,
            privateKey: encryptedPrivateKey ? decrypt(encryptedPrivateKey) : undefined,
            passphrase: encryptedPassphrase ? decrypt(encryptedPassphrase) : undefined,
            password: encSshPassword ? decrypt(encSshPassword) : undefined,
        };
    }

    return config;
}

/**
 * NOTE on production hardening: the encryption key itself lives on the same
 * disk as the ciphertext (see crypto.ts) — fine for a local dev tool, not
 * fine for a shared server. A real deployment should source the key from an
 * OS keychain or secrets manager instead.
 */
class ConnectionStore {
    private connections = new Map<string, StoredConnection>();
    // Keyed by connection id, reused across testConnection (in create()) and
    // getLive() so a connection only ever opens one SSH tunnel, not one per call.
    private tunnels = new Map<string, Promise<TunnelHandle>>();

    constructor() {
        this.loadFromDisk();
    }

    private loadFromDisk() {
        if (!fs.existsSync(STORE_PATH)) return;
        try {
            const raw: PersistedConfig[] = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            for (const p of raw) {
                const config = decodeConfig(p);
                this.connections.set(config.id, { config });
            }
        } catch (err) {
            logger.error({ err }, "Failed to load persisted connections");
        }
    }

    private saveToDisk() {
        const persisted = [...this.connections.values()].map(({ config }) => encodeConfig(config));
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    }

    /**
     * If this config asks for an SSH tunnel, opens it (or reuses the one
     * already open for this connection id) and returns a copy pointed at the
     * local forwarded port instead of the real host — otherwise returns the
     * config unchanged. Requires an explicit host+port to tunnel to.
     */
    private async withTunnel(config: ConnectionConfig): Promise<ConnectionConfig> {
        if (!config.sshTunnel?.enabled || !config.host || !config.port) return config;

        let tunnelPromise = this.tunnels.get(config.id);
        if (!tunnelPromise) {
            tunnelPromise = openSshTunnel(config.sshTunnel, config.host, config.port);
            this.tunnels.set(config.id, tunnelPromise);
            tunnelPromise.catch(() => this.tunnels.delete(config.id)); // let a failed attempt be retried
        }
        const tunnel = await tunnelPromise;
        return { ...config, host: "127.0.0.1", port: tunnel.localPort };
    }

    private closeTunnel(id: string) {
        const tunnelPromise = this.tunnels.get(id);
        if (!tunnelPromise) return;
        this.tunnels.delete(id);
        tunnelPromise.then((t) => t.close()).catch(() => { });
    }

    async create(input: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig> {
        const id = nanoid();
        const config: ConnectionConfig = { ...input, id };
        const driver = registry.get(config.driver);
        const test = await driver.testConnection(await this.withTunnel(config));
        if (!test.ok) {
            this.closeTunnel(id);
            throw new Error(test.message ?? "Connection test failed");
        }
        this.connections.set(id, { config });
        this.saveToDisk();
        return redact(config);
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
            entry.live = await driver.connect(await this.withTunnel(entry.config));
        }
        return entry.live;
    }

    async remove(id: string): Promise<void> {
        const entry = this.connections.get(id);
        if (!entry) return;
        if (entry.live) await entry.live.close();
        this.closeTunnel(id);
        this.connections.delete(id);
        this.saveToDisk();
    }

    /** Closes every currently-open driver connection (and SSH tunnel) without deleting the saved configs. Used on graceful shutdown. */
    async closeAll(): Promise<void> {
        const closes = [...this.connections.values()]
            .filter((entry) => entry.live)
            .map((entry) => entry.live!.close().catch(() => { }));
        await Promise.all(closes);
        for (const id of [...this.tunnels.keys()]) this.closeTunnel(id);
    }
}

function redact(config: ConnectionConfig): ConnectionConfig {
    const redacted: ConnectionConfig = { ...config, password: config.password ? "••••••••" : undefined };
    if (redacted.ssl && typeof redacted.ssl === "object") {
        redacted.ssl = { ...redacted.ssl, key: redacted.ssl.key ? "••••••••" : undefined };
    }
    if (redacted.sshTunnel) {
        redacted.sshTunnel = {
            ...redacted.sshTunnel,
            privateKey: redacted.sshTunnel.privateKey ? "••••••••" : undefined,
            passphrase: redacted.sshTunnel.passphrase ? "••••••••" : undefined,
            password: redacted.sshTunnel.password ? "••••••••" : undefined,
        };
    }
    return redacted;
}

export const connectionStore = new ConnectionStore();
