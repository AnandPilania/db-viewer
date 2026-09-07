import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
export default fp(async function rateLimitPlugin(app) {
    await app.register(rateLimit, {
        max: 300,
        timeWindow: "1 minute",
    });
});
//# sourceMappingURL=rate-limit.js.map