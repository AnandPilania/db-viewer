import type { FastifyInstance } from "fastify";
/**
 * Wrapped with fastify-plugin so it registers against the *parent* Fastify
 * instance rather than creating an encapsulation boundary — every route in
 * the app needs CORS, not just siblings within this file.
 */
declare const _default: (app: FastifyInstance) => Promise<void>;
export default _default;
