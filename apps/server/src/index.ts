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
import { clientErrorRoutes } from "./routes/client-errors.js";
import { registry } from "./registry.js";
import { logger } from "./logger.js";

// Anything that reaches here would otherwise crash the process silently (or
// with only a stdout stack trace lost the moment the terminal closes) — log
// it to the daily file first. An uncaught exception leaves the process in an
// unknown state, so we still exit after logging; a rejected promise that
// nobody awaited is usually recoverable, so we only log it.
process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
});

const app = Fastify({ loggerInstance: logger });

await registry.discover();
const active = registry.list();
const missing = registry.listUnavailable();
if (active.length === 0) {
    app.log.warn(
        "No database drivers are installed. Install at least one, e.g.:\n" +
        "  npm install @pilaniaanand/driver-postgres"
    );
} else {
    app.log.info(`Drivers available: ${active.map((d) => d.key).join(", ")}`);
}
if (missing.length > 0) {
    app.log.info(
        `Drivers not installed (npm install @pilaniaanand/driver-<name> to enable): ${missing
            .map((d) => d.key)
            .join(", ")}`
    );
}

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
await app.register(clientErrorRoutes);

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
