import type { FastifyInstance } from "fastify";
/**
 * Streams every row of a table to the client as it's fetched from the
 * database, one keyset page at a time. Memory usage stays flat regardless
 * of table size — this never holds more than one page of rows at once,
 * whether the table has a thousand rows or a trillion.
 */
export declare function exportRoutes(app: FastifyInstance): Promise<void>;
