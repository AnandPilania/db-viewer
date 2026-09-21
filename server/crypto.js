import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const DATA_DIR = path.resolve(process.cwd(), ".data");
const KEY_PATH = path.join(DATA_DIR, "secret.key");
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR))
        fs.mkdirSync(DATA_DIR, { recursive: true });
}
/**
 * Resolves the symmetric key used to encrypt saved connection passwords at
 * rest, in order of preference:
 *
 *   1. DB_VIEWER_SECRET_KEY       — 64 hex chars (32 bytes), e.g. from a
 *                                   secrets manager injected as an env var.
 *   2. DB_VIEWER_SECRET_KEY_FILE  — path to a file containing the same, for
 *                                   Docker/Kubernetes secret mounts, which
 *                                   land as files rather than env vars.
 *   3. .data/secret.key           — generated on first run.
 *
 * (3) is convenience for a local install, not security: the key sits on the
 * same disk as the ciphertext it protects, so anyone who can read .data/ has
 * every database password. It warns loudly for that reason. Use (1) or (2)
 * for anything shared or deployed.
 */
function readKeyMaterial(source, raw) {
    const hex = raw.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`${source} must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32`);
    }
    return Buffer.from(hex, "hex");
}
function loadOrCreateKey() {
    const inline = process.env.DB_VIEWER_SECRET_KEY;
    if (inline)
        return readKeyMaterial("DB_VIEWER_SECRET_KEY", inline);
    const keyFile = process.env.DB_VIEWER_SECRET_KEY_FILE;
    if (keyFile) {
        if (!fs.existsSync(keyFile))
            throw new Error(`DB_VIEWER_SECRET_KEY_FILE points at a missing file: ${keyFile}`);
        return readKeyMaterial("DB_VIEWER_SECRET_KEY_FILE", fs.readFileSync(keyFile, "utf-8"));
    }
    ensureDataDir();
    if (fs.existsSync(KEY_PATH)) {
        return readKeyMaterial(KEY_PATH, fs.readFileSync(KEY_PATH, "utf-8"));
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, key.toString("hex"), { mode: 0o600 });
    return key;
}
/** True when the key came from the generated local file rather than an injected secret. */
export const usingLocalKeyFile = !process.env.DB_VIEWER_SECRET_KEY && !process.env.DB_VIEWER_SECRET_KEY_FILE;
const key = loadOrCreateKey();
export function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}
export function decrypt(payload) {
    try {
        return decryptUnchecked(payload);
    }
    catch (err) {
        // Almost always a key mismatch (the .data/secret.key was regenerated, or
        // DB_VIEWER_SECRET_KEY changed) rather than corruption — GCM's auth tag
        // fails identically either way, and "unsupported state or unable to
        // authenticate data" tells the operator nothing about what to do.
        throw new Error("Could not decrypt a stored credential — the encryption key does not match the one used to save it. " +
            "Restore the original DB_VIEWER_SECRET_KEY / .data/secret.key, or delete the affected connection and re-add it. " +
            `(${err.message})`, { cause: err });
    }
}
function decryptUnchecked(payload) {
    const buf = Buffer.from(payload, "base64");
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}
export { DATA_DIR };
//# sourceMappingURL=crypto.js.map