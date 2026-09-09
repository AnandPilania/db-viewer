import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

/**
 * `origin: true` — which is what this used to be — reflects whatever Origin
 * the request carries, so with no auth in front of it *any* website the user
 * happened to have open could read and write every database configured here.
 * That is the whole API surface, from a page the user never trusted.
 *
 * So: same-origin only by default (no CORS headers at all — the UI is served
 * from this same process and port, so it needs none), plus localhost origins
 * for the two-process `pnpm dev:web` + `pnpm dev:server` workflow where Vite
 * serves the UI from a different port.
 *
 * DB_VIEWER_ALLOWED_ORIGINS (comma-separated) is the escape hatch for a real
 * deployment behind a reverse proxy. `*` is accepted but deliberately
 * requires being spelled out.
 */
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export default fp(async function corsPlugin(app: FastifyInstance) {
  const configured = (process.env.DB_VIEWER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (configured.includes("*")) {
    app.log.warn("DB_VIEWER_ALLOWED_ORIGINS=* — every origin may call this API. Do not use this on a shared host.");
    await app.register(cors, { origin: true, credentials: false });
    return;
  }

  await app.register(cors, {
    credentials: false,
    origin(origin, cb) {
      // No Origin header: same-origin navigation, curl, a server-side call.
      if (!origin) return cb(null, true);
      if (LOCALHOST.test(origin) || configured.includes(origin)) return cb(null, true);
      // Refuse rather than error — the browser blocks it either way, and a
      // rejected preflight logging a stack trace per probe is just noise.
      cb(null, false);
    },
  });
});
