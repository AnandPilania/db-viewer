import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { connectionStore } from "../connection-store.js";

/**
 * Without this, killing the server (Ctrl+C, container stop, `tsx watch`
 * restart) leaves database connection pools dangling until the OS reclaims
 * the sockets. Postgres/MySQL pools and the MongoDB client all get a clean
 * `.close()` call before the process actually exits.
 */
export default fp(async function gracefulShutdownPlugin(app: FastifyInstance) {
  app.addHook("onClose", async () => {
    app.log.info("Closing all live database connections...");
    await connectionStore.closeAll();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err, "Error during graceful shutdown");
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
});
