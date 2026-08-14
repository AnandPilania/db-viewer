import type { FastifyInstance } from "fastify";
import { connectionStore } from "../connection-store.js";

const PAGE_SIZE = 1000;

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return "";
    const str = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

/**
 * Streams every row of a table to the client as it's fetched from the
 * database, one keyset page at a time. Memory usage stays flat regardless
 * of table size — this never holds more than one page of rows at once,
 * whether the table has a thousand rows or a trillion.
 */
export async function exportRoutes(app: FastifyInstance) {
    app.get("/api/connections/:id/tables/:table/export", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema, format = "csv" } = req.query as { schema?: string; format?: "csv" | "ndjson" };

        const controller = new AbortController();
        req.raw.on("close", () => controller.abort());

        let conn;
        try {
            conn = await connectionStore.getLive(id);
        } catch (err) {
            reply.code(400);
            return { error: (err as Error).message };
        }

        const filename = `${table}.${format === "csv" ? "csv" : "ndjson"}`;
        reply.raw.writeHead(200, {
            "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Transfer-Encoding": "chunked",
        });

        let cursor: string | null = null;
        let wroteHeader = false;
        let rowCount = 0;

        try {
            while (true) {
                if (controller.signal.aborted) break;
                const page = await conn.queryRows({
                    table,
                    schema,
                    pageSize: PAGE_SIZE,
                    afterCursor: cursor,
                    signal: controller.signal,
                });

                if (format === "csv" && !wroteHeader) {
                    const headerCols = page.columns.length ? page.columns.map((c) => c.name) : Object.keys(page.rows[0] ?? {});
                    reply.raw.write(headerCols.map(csvEscape).join(",") + "\n");
                    wroteHeader = true;
                }

                for (const row of page.rows) {
                    if (format === "csv") {
                        const cols = page.columns.length ? page.columns.map((c) => c.name) : Object.keys(row);
                        reply.raw.write(cols.map((c) => csvEscape(row[c])).join(",") + "\n");
                    } else {
                        reply.raw.write(JSON.stringify(row) + "\n");
                    }
                    rowCount++;
                }

                cursor = page.nextCursor;
                if (!cursor) break;
            }
        } catch (err) {
            reply.raw.write(format === "csv" ? `\n# ERROR: ${(err as Error).message}\n` : `{"error":"${(err as Error).message}"}\n`);
            app.log.error({ err, table, rowCount }, "export failed mid-stream");
        } finally {
            reply.raw.end();
        }
    });
}
