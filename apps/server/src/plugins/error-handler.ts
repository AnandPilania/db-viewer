import fp from "fastify-plugin";
import type { FastifyInstance, FastifyError } from "fastify";

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
export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
    app.setErrorHandler((err: FastifyError, req, reply) => {
        const status = err.statusCode ?? 500;
        if (status >= 500) {
            app.log.error({ err, url: req.url, method: req.method }, "Unhandled request error");
        }
        reply.code(status).send({
            error: status >= 500 ? "Internal server error" : err.message,
        });
    });
});
