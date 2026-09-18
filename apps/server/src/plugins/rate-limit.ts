import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const DEFAULT_MAX = envInt("DB_VIEWER_RATE_LIMIT", 300);
/**
 * Routes that hand the caller a database's worth of work or data on one
 * request: raw statement execution and full-table export. The default bucket
 * is sized for a UI browsing tables, which makes it far too generous for
 * these — a loop against /export walks out with the whole database well
 * inside 300 requests.
 */
const HEAVY_MAX = envInt("DB_VIEWER_RATE_LIMIT_HEAVY", 30);

function isHeavy(req: FastifyRequest): boolean {
  const route = req.routeOptions?.url ?? req.url;
  return route.endsWith("/execute") || route.endsWith("/export");
}

export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    // A function rather than per-route config so a new heavy route is covered
    // by matching the pattern here, not by remembering to annotate it.
    max: (req: FastifyRequest) => (isHeavy(req) ? HEAVY_MAX : DEFAULT_MAX),
    timeWindow: "1 minute",
    // ponytail: in-memory, so limits are per-process. Fine for a single-node
    // deploy; point it at a Redis store if this is ever run behind more than
    // one instance.
  });
});
