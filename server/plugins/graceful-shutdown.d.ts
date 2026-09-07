import type { FastifyInstance } from "fastify";
/**
 * Without this, killing the server (Ctrl+C, container stop, `tsx watch`
 * restart) leaves database connection pools dangling until the OS reclaims
 * the sockets. Postgres/MySQL pools and the MongoDB client all get a clean
 * `.close()` call before the process actually exits.
 */
declare const _default: (app: FastifyInstance) => Promise<void>;
export default _default;
