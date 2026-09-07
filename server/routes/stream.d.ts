import type { FastifyInstance } from "fastify";
/**
 * Client sends: { type: "run", query: QuerySpec }
 *   QuerySpec is a discriminated union on `language` — "sql" | "mongo" |
 *   "redis-command" — matching the connection's driver.capabilities.queryLanguage
 *   (see @pilaniaanand/driver-interface and GET /api/drivers). The client is
 *   expected to build the right shape; the server does not attempt to
 *   translate between languages.
 * Server sends repeated: { type: "chunk", rows: [...], columns: [...] }
 *          then:         { type: "done", durationMs }
 *          or on error:  { type: "error", message }
 * Client can send: { type: "cancel" } at any point to abort mid-stream.
 */
export declare function streamRoutes(app: FastifyInstance): Promise<void>;
