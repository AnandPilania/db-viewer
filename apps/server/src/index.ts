import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { connectionRoutes } from "./routes/connections.js";
import { streamRoutes } from "./routes/stream.js";
import { exportRoutes } from "./routes/export.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

await app.register(connectionRoutes);
await app.register(streamRoutes);
await app.register(exportRoutes);

app.get("/api/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
});
