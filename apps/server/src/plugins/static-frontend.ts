import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";

export default fp(async function staticFrontendPlugin(app: FastifyInstance) {
    const webDist = path.resolve(process.cwd(), "../web/dist");
    const fallbackDist = path.resolve(process.cwd(), "public");

    const root = fs.existsSync(path.join(webDist, "index.html"))
        ? webDist
        : fs.existsSync(path.join(fallbackDist, "index.html"))
            ? fallbackDist
            : null;

    if (!root) {
        app.log.info("No built frontend found — running API-only (normal for `pnpm dev`).");
        return;
    }

    await app.register(fastifyStatic, {
        root,
        wildcard: false,
        serve: true,
    });

    app.get("/*", async (req, reply) => {
        if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
            return reply.code(404).send({ error: `No route: ${req.method} ${req.url}` });
        }
        return reply.sendFile("index.html", root);
    });

    app.log.info(`Serving built frontend from ${root}`);
});
