import Fastify from "fastify";
import {
    corsPlugin,
    websocketPlugin,
    rateLimitPlugin,
    errorHandlerPlugin,
    gracefulShutdownPlugin,
    staticFrontendPlugin,
} from "./plugins/index.js";
import { connectionRoutes } from "./routes/connections.js";
import { streamRoutes } from "./routes/stream.js";
import { exportRoutes } from "./routes/export.js";
import { widgetRoutes } from "./routes/widgets.js";
import { dashboardRoutes } from "./routes/dashboards.js";
import { watchRoutes } from "./routes/watch.js";
import { publicWatchRoutes } from "./routes/public-watch.js";

const app = Fastify({ logger: true });

await app.register(errorHandlerPlugin);
await app.register(gracefulShutdownPlugin);
await app.register(rateLimitPlugin);
await app.register(corsPlugin);
await app.register(websocketPlugin);

await app.register(connectionRoutes);
await app.register(streamRoutes);
await app.register(exportRoutes);
await app.register(widgetRoutes);
await app.register(dashboardRoutes);
await app.register(watchRoutes);
await app.register(publicWatchRoutes);

app.get("/api/health", async () => ({ ok: true }));

// Registered last so its SPA-fallback 404 handler takes over from
// errorHandlerPlugin's JSON 404 — but only once a built frontend is
// actually found (see the plugin for details).
await app.register(staticFrontendPlugin);

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
});
