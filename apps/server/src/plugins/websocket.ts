import fp from "fastify-plugin";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

export default fp(async function websocketPlugin(app: FastifyInstance) {
  await app.register(websocket, {
    options: {
      // Large query results stream in many small frames; keep the per-message
      // cap generous but bounded so a single malformed client message can't
      // exhaust memory before our own JSON.parse rejects it.
      maxPayload: 10 * 1024 * 1024,
    },
  });
});
