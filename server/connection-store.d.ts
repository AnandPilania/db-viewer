import type { ConnectionConfig, DriverConnection } from "@pilaniaanand/driver-interface";
/**
 * NOTE on production hardening: the encryption key itself lives on the same
 * disk as the ciphertext (see crypto.ts) — fine for a local dev tool, not
 * fine for a shared server. A real deployment should source the key from an
 * OS keychain or secrets manager instead.
 */
declare class ConnectionStore {
    private connections;
    private tunnels;
    constructor();
    private loadFromDisk;
    private saveToDisk;
    /**
     * If this config asks for an SSH tunnel, opens it (or reuses the one
     * already open for this connection id) and returns a copy pointed at the
     * local forwarded port instead of the real host — otherwise returns the
     * config unchanged. Requires an explicit host+port to tunnel to.
     */
    private withTunnel;
    private closeTunnel;
    create(input: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig>;
    list(): ConnectionConfig[];
    getConfig(id: string): ConnectionConfig;
    getLive(id: string): Promise<DriverConnection>;
    remove(id: string): Promise<void>;
    /** Closes every currently-open driver connection (and SSH tunnel) without deleting the saved configs. Used on graceful shutdown. */
    closeAll(): Promise<void>;
}
export declare const connectionStore: ConnectionStore;
export {};
