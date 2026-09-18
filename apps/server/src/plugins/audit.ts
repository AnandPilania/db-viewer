import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, summarizeValue } from "../audit.js";

/**
 * Audits every request that changes data or takes it out of the database,
 * as a global hook rather than a call inside each handler — a route added
 * next month is audited by default instead of by remembering to.
 *
 * Reads are not audited individually: browsing a table is the app's normal
 * idle behaviour and would bury the trail. The reads that *are* recorded are
 * the ones that move data out of the system (export, raw execute, public
 * embed endpoints).
 */
const AUDITED_READS = [/\/export$/, /^\/api\/public\//];

/** Request bodies carry credentials and row data; record the shape, never the secret. */
const NEVER_RECORD = new Set(["password", "sshPassword", "sshPrivateKey", "sshPassphrase", "key", "cert", "ca", "token"]);

function summarizeBody(body: unknown): Record<string, unknown> | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (NEVER_RECORD.has(k)) continue; // omitted entirely — not even a shape tag
        // Which row and which column were touched is the substance of the
        // audit, so those are recorded verbatim; the data itself is summarized
        // unless DB_VIEWER_AUDIT_VALUES is set.
        out[k] = k === "column" || k === "primaryKey" || k === "table" || k === "sql" ? v : summarizeValue(v);
    }
    return out;
}

export default fp(async function auditPlugin(app: FastifyInstance) {
    app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
        const route = req.routeOptions?.url ?? req.url.split("?")[0];
        const isMutation = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
        const isAuditedRead = AUDITED_READS.some((p) => p.test(route));
        // Client-side error reports are inbound telemetry, not an action taken
        // against a database — auditing them only adds noise.
        if (route === "/api/client-errors") return;
        if (!isMutation && !isAuditedRead) return;

        const params = (req.params ?? {}) as Record<string, string>;
        audit({
            action: `${req.method} ${route}`,
            method: req.method,
            route,
            status: reply.statusCode,
            durationMs: Math.round(reply.elapsedTime),
            ip: req.ip,
            userAgent: req.headers["user-agent"],
            connectionId: params.id,
            table: params.table,
            detail: summarizeBody(req.body),
        });
    });
});
