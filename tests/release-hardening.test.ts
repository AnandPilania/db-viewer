import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.useRealTimers();
});

/**
 * A share link lives forever in whatever wiki or chat it was pasted into, so
 * the expiry is the only thing that ever revokes it on its own.
 */
describe("embed token expiry", () => {
    const load = async () => {
        vi.resetModules();
        return (await import("../packages/modules/dashboards/src/server/dashboard-store.js")).dashboardStore;
    };

    it("expires a new token 30 days out by default", async () => {
        const store = await load();
        const d = store.create("t");
        const withToken = store.setEmbedEnabled(d.id, true);
        const days = (Date.parse(withToken.shareTokenExpiresAt!) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(29.9);
        expect(days).toBeLessThan(30.1);
        store.remove(d.id);
    });

    it("honours DB_VIEWER_EMBED_TOKEN_TTL_DAYS, and 0 means never", async () => {
        process.env.DB_VIEWER_EMBED_TOKEN_TTL_DAYS = "0";
        const store = await load();
        const d = store.create("t");
        expect(store.setEmbedEnabled(d.id, true).shareTokenExpiresAt).toBeNull();
        store.remove(d.id);
    });

    it("rotating replaces the token, so the previous link stops working", async () => {
        const store = await load();
        const d = store.create("t");
        const first = store.setEmbedEnabled(d.id, true).shareToken;
        const second = store.rotateShareToken(d.id).shareToken;
        expect(second).not.toBe(first);
        expect(second).toHaveLength(48);
        store.remove(d.id);
    });

    it("refuses to rotate a dashboard that has embedding switched off", async () => {
        const store = await load();
        const d = store.create("t");
        expect(() => store.rotateShareToken(d.id)).toThrow(/not enabled/);
        store.remove(d.id);
    });

    it("clears the token and its expiry when embedding is switched off", async () => {
        const store = await load();
        const d = store.create("t");
        store.setEmbedEnabled(d.id, true);
        const off = store.setEmbedEnabled(d.id, false);
        expect(off.shareToken).toBeNull();
        expect(off.shareTokenExpiresAt).toBeNull();
        store.remove(d.id);
    });
});

/**
 * An iframe cannot send a header, so the embed token rides in the query
 * string — which means it would otherwise be written to the request log as a
 * working credential, outliving the link itself.
 */
describe("audit value summarization", () => {
    const load = async (recordValues: boolean) => {
        vi.resetModules();
        if (recordValues) process.env.DB_VIEWER_AUDIT_VALUES = "true";
        else delete process.env.DB_VIEWER_AUDIT_VALUES;
        return (await import("../apps/server/src/audit.js")).summarizeValue;
    };

    it("records a value's shape, not its contents, by default", async () => {
        const summarize = await load(false);
        expect(summarize("bob@example.com")).toBe("<string:15>");
        expect(summarize(42)).toBe("<number>");
        expect(summarize(null)).toBe("<null>");
        expect(summarize([1, 2, 3])).toBe("<array:3>");
        expect(summarize({ a: 1, b: 2 })).toBe("<object:a,b>");
    });

    it("records real values only when explicitly opted in", async () => {
        const summarize = await load(true);
        expect(summarize("bob@example.com")).toBe("bob@example.com");
    });
});

describe("encryption key source", () => {
    const load = async () => {
        vi.resetModules();
        return import("../apps/server/src/crypto.js");
    };

    it("accepts an injected key and round-trips a secret with it", async () => {
        process.env.DB_VIEWER_SECRET_KEY = "a".repeat(64);
        const { encrypt, decrypt, usingLocalKeyFile } = await load();
        expect(usingLocalKeyFile).toBe(false);
        expect(decrypt(encrypt("hunter2"))).toBe("hunter2");
    });

    it("rejects a malformed key instead of silently falling back to a generated one", async () => {
        process.env.DB_VIEWER_SECRET_KEY = "not-hex";
        await expect(load()).rejects.toThrow(/64 hex characters/);
    });

    it("reports a key mismatch as a key mismatch, not as a cipher error", async () => {
        process.env.DB_VIEWER_SECRET_KEY = "a".repeat(64);
        const ciphertext = (await load()).encrypt("hunter2");
        process.env.DB_VIEWER_SECRET_KEY = "b".repeat(64);
        const { decrypt } = await load();
        expect(() => decrypt(ciphertext)).toThrow(/encryption key does not match/);
    });
});
