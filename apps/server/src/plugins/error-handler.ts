import fp from "fastify-plugin";
import type { FastifyInstance, FastifyError } from "fastify";

/**
 * Route handlers in this app mostly catch their own driver errors and
 * return a `{ error }` body with an explicit status code (see
 * routes/connections.ts). This plugin is the safety net for everything
 * else: malformed JSON bodies, unexpected exceptions, unknown routes — so
 * the API never leaks a raw stack trace or Fastify's default HTML 404.
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

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `No route: ${req.method} ${req.url}` });
  });
});
