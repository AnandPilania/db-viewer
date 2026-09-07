import type { FastifyInstance } from "fastify";
/**
 * Client connects to /ws/connections/:id/tables/:table/watch and receives
 * every insert/update/delete published for that table. This is the
 * internal/authenticated-equivalent channel — it exposes the raw
 * connectionId and table name in the URL, which is fine for the app's own
 * UI (same trust level as every other internal API route) but must never
 * be reachable from a public embed view. See routes/public-watch.ts for
 * that channel's token-gated, connection-detail-hiding equivalent.
 */
export declare function watchRoutes(app: FastifyInstance): Promise<void>;
