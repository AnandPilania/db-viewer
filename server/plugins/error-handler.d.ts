import type { FastifyInstance } from "fastify";
/**
 * Route handlers in this app mostly catch their own driver errors and
 * return a `{ error }` body with an explicit status code (see
 * routes/connections.ts). This plugin is the safety net for everything
 * else: malformed JSON bodies, unexpected exceptions, unknown routes — so
 * the API never leaks a raw stack trace or Fastify's default HTML 404.
 */
/**
 * Route handlers in this app mostly catch their own driver errors and
 * return a `{ error }` body with an explicit status code (see
 * routes/connections.ts). This plugin is the safety net for everything
 * else: malformed JSON bodies, unexpected exceptions — so the API never
 * leaks a raw stack trace. 404 handling lives in static-frontend.ts
 * instead of here — Fastify only allows one setNotFoundHandler call per
 * instance, and that plugin needs to decide between a JSON 404 and the
 * SPA fallback, so it owns that decision entirely.
 */
declare const _default: (app: FastifyInstance) => Promise<void>;
export default _default;
