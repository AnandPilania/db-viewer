import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

/**
 * Wrapped with fastify-plugin so it registers against the *parent* Fastify
 * instance rather than creating an encapsulation boundary — every route in
 * the app needs CORS, not just siblings within this file.
 */
export default fp(async function corsPlugin(app: FastifyInstance) {
  await app.register(cors, { origin: true });
});
