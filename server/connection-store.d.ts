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
    /** Only patch keys that are actually present are applied — `undefined` means "leave as-is", so a client can omit a secret it isn't changing without wiping it. */
    update(id: string, patch: Partial<Omit<ConnectionConfig, "id">>): Promise<ConnectionConfig>;
    /**
     * Tests a config without persisting it or touching any already-open pool
     * or tunnel — used by the "Test connection" button for a not-yet-saved
     * config, and for a saved one with unsaved edits applied on top. Always
     * runs under a throwaway id so a concurrent tunnel for the real
     * connection (if any) is never reused or torn down by this call.
     */
    private testConfig;
    /** Test a brand-new connection before it's ever created. */
    testNew(input: Omit<ConnectionConfig, "id">): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** Test a saved connection, optionally with unsaved edits (same merge rule as `update`) layered on top. */
    testExisting(id: string, patch?: Partial<Omit<ConnectionConfig, "id">>): Promise<{
        ok: boolean;
        message?: string;
    }>;
    list(): ConnectionConfig[];
    getConfig(id: string): ConnectionConfig;
    getLive(id: string): Promise<DriverConnection>;
    remove(id: string): Promise<void>;
    /** Closes every currently-open driver connection (and SSH tunnel) without deleting the saved configs. Used on graceful shutdown. */
    closeAll(): Promise<void>;
}
export declare const connectionStore: ConnectionStore;
export {};
