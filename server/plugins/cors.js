import fp from "fastify-plugin";
import cors from "@fastify/cors";
/**
 * Wrapped with fastify-plugin so it registers against the *parent* Fastify
 * instance rather than creating an encapsulation boundary — every route in
 * the app needs CORS, not just siblings within this file.
 */
export default fp(async function corsPlugin(app) {
    await app.register(cors, { origin: true });
});
//# sourceMappingURL=cors.js.map