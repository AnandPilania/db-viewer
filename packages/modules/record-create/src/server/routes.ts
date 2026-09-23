import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { ConnectionConfig, DriverConnection, RowChangeEvent } from "@pilaniaanand/driver-interface";
import { mapConstraintError } from "./errorMapping.js";

/**
 * Everything this route needs from the host app, passed in as plugin
 * registration options rather than imported directly — so this package has
 * no dependency back on the app hosting it (see apps/server/src/index.ts,
 * which registers this plugin with its own connectionStore/tableEvents).
 */
export interface RecordCreateRouteOptions {
    connectionStore: {
        getConfig(id: string): ConnectionConfig;
        getLive(id: string): Promise<DriverConnection>;
    };
    tableEvents: {
        publish(connectionId: string, table: string, event: RowChangeEvent): void;
    };
    assertWritable: (config: ConnectionConfig) => void;
    ReadOnlyError: new (message?: string) => Error;
}

export default fp<RecordCreateRouteOptions>(async function recordCreateRoutes(app: FastifyInstance, opts) {
    const { connectionStore, tableEvents, assertWritable, ReadOnlyError } = opts;

    app.post("/api/connections/:id/tables/:table/records", async (req, reply) => {
        const { id, table } = req.params as { id: string; table: string };
        const { schema, values } = req.body as { schema?: string; values: Record<string, unknown> };
        try {
            assertWritable(connectionStore.getConfig(id));
            const conn = await connectionStore.getLive(id);
            const inserted = await conn.insertRow(table, schema, values);
            tableEvents.publish(id, table, { type: "insert", row: inserted });
            reply.code(201);
            return inserted;
        } catch (err) {
            if (err instanceof ReadOnlyError) {
                reply.code(403);
                return { error: (err as Error).message };
            }
            // Same status code the route used before extraction — only the
            // response body grows a `fieldErrors` array when we can map one.
            reply.code(400);
            const driverKey = connectionStore.getConfig(id).driver;
            const fieldErrors = mapConstraintError(err, driverKey);
            return fieldErrors
                ? { error: (err as Error).message, fieldErrors }
                : { error: (err as Error).message };
        }
    });
});
