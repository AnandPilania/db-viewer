import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the built frontend (apps/web/dist) from the same process and port
 * as the API — this is what lets `npx db-viewer` be a single command
 * instead of "run two servers on two ports." Only registers if a built
 * frontend actually exists; the normal `pnpm dev:server` + `pnpm dev:web`
 * workflow (two separate processes, Vite's own dev server) is untouched.
 *
 * Two places are checked, in order:
 *  1. `../web/dist` relative to process.cwd() — the monorepo dev layout,
 *     where `pnpm start` runs from the repo root and apps/web is a sibling.
 *  2. `public/` next to *this compiled file* (not cwd) — the published
 *     package layout, where the CLI (bin/db-viewer.js) copies the web
 *     build in at publish time. Resolving against import.meta.url instead
 *     of cwd means this still finds it even if db-viewer is launched from
 *     some other working directory.
 *
 * SPA fallback: any request that isn't for /api, /ws, or an actual static
 * file gets index.html, so client-side routes (including /embed/:id, which
 * the frontend resolves by reading the URL itself) work on a hard refresh.
 */
export default fp(async function staticFrontendPlugin(app: FastifyInstance) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(process.cwd(), "../web/dist");
  const fallbackDist = path.resolve(__dirname, "../../public"); // <package>/public — see bin/db-viewer.js

  const root = fs.existsSync(path.join(webDist, "index.html"))
    ? webDist
    : fs.existsSync(path.join(fallbackDist, "index.html"))
      ? fallbackDist
      : null;

  if (!root) {
    app.log.info("No built frontend found — running API-only (normal for `pnpm dev`).");
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: `No route: ${req.method} ${req.url}` });
    });
    return;
  }

  await app.register(fastifyStatic, { root, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      reply.code(404).send({ error: `No route: ${req.method} ${req.url}` });
      return;
    }
    reply.sendFile("index.html", root);
  });

  app.log.info(`Serving built frontend from ${root}`);
});
