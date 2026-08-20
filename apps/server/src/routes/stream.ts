import type { FastifyInstance } from "fastify";
import type { QuerySpec } from "@db-viewer/driver-interface";
import { connectionStore } from "../connection-store.js";

/**
 * Client sends: { type: "run", query: QuerySpec }
 *   QuerySpec is a discriminated union on `language` — "sql" | "mongo" |
 *   "redis-command" — matching the connection's driver.capabilities.queryLanguage
 *   (see @db-viewer/driver-interface and GET /api/drivers). The client is
 *   expected to build the right shape; the server does not attempt to
 *   translate between languages.
 * Server sends repeated: { type: "chunk", rows: [...], columns: [...] }
 *          then:         { type: "done", durationMs }
 *          or on error:  { type: "error", message }
 * Client can send: { type: "cancel" } at any point to abort mid-stream.
 */
export async function streamRoutes(app: FastifyInstance) {
  app.get("/ws/connections/:id/stream", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    let controller: AbortController | null = null;

    socket.on("message", async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
        return;
      }

      if (msg.type === "cancel") {
        controller?.abort();
        return;
      }

      if (msg.type === "run") {
        const query = msg.query as QuerySpec | undefined;
        if (!query || typeof query.language !== "string") {
          socket.send(JSON.stringify({ type: "error", message: 'Missing or invalid "query" in run message' }));
          return;
        }
        controller = new AbortController();
        const start = performance.now();
        try {
          const conn = await connectionStore.getLive(id);
          for await (const chunk of conn.streamQuery({ query, signal: controller.signal })) {
            if (controller.signal.aborted) break;
            socket.send(JSON.stringify({ type: "chunk", rows: chunk.rows, columns: chunk.columns }));
          }
          if (!controller.signal.aborted) {
            socket.send(JSON.stringify({ type: "done", durationMs: performance.now() - start }));
          } else {
            socket.send(JSON.stringify({ type: "cancelled" }));
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: "error", message: (err as Error).message }));
        }
      }
    });

    socket.on("close", () => controller?.abort());
  });
}
