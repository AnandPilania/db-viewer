import Fastify from "fastify";
import {
    auditPlugin,
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
import { watchRoutes } from "./routes/watch.js";
import { clientErrorRoutes } from "./routes/client-errors.js";
import { registry } from "./registry.js";
import { logger } from "./logger.js";
import { usingLocalKeyFile } from "./crypto.js";
import { connectionStore } from "./connection-store.js";
import { tableEvents, ensureNativeWatch, releaseNativeWatch } from "./table-events.js";
import { assertWritable, ReadOnlyError } from "./read-only.js";
import { recordCreateRoutes } from "@pilaniaanand/module-record-create/server";
import { dashboardModuleRoutes } from "@pilaniaanand/module-dashboards/server";

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
await app.register(auditPlugin);
await app.register(rateLimitPlugin);
await app.register(corsPlugin);
await app.register(websocketPlugin);

await app.register(connectionRoutes);
await app.register(recordCreateRoutes, { connectionStore, tableEvents, assertWritable, ReadOnlyError });
await app.register(streamRoutes);
await app.register(exportRoutes);
await app.register(dashboardModuleRoutes, { connectionStore, tableEvents, ensureNativeWatch, releaseNativeWatch });
await app.register(watchRoutes);
await app.register(clientErrorRoutes);

app.get("/api/health", async () => ({ ok: true }));

// Registered last so its SPA-fallback 404 handler takes over from
// errorHandlerPlugin's JSON 404 — but only once a built frontend is
// actually found (see the plugin for details).
await app.register(staticFrontendPlugin);

if (usingLocalKeyFile) {
    app.log.warn(
        "Database passwords are encrypted with a key generated in .data/secret.key — on the same disk as the data it protects. " +
        "Set DB_VIEWER_SECRET_KEY (openssl rand -hex 32) or DB_VIEWER_SECRET_KEY_FILE for anything shared or deployed."
    );
}

const port = Number(process.env.PORT ?? 4000);

// Loopback by default. This process holds decrypted credentials for every
// configured database and has no authentication of its own, so binding all
// interfaces made it reachable by anything on the network. HOST=0.0.0.0 is
// still available for container/remote use, where putting real auth in front
// of it is the operator's job.
const host = process.env.HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    app.log.warn(
        `Listening on ${host} — this API has no authentication and holds credentials for every configured database. Put a reverse proxy with auth in front of it.`
    );
}

app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
});
