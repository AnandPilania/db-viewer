import type { ConnectionConfig, ExecSpec } from "@pilaniaanand/driver-interface";
/**
 * A connection is read-only if either:
 *  - DB_VIEWER_READ_ONLY=true is set — a global override that applies to
 *    every connection no matter what, so an operator can lock the whole
 *    running instance down without touching any saved connection config; or
 *  - the connection itself was saved with `readOnly: true`.
 *
 * This is enforced here, at the route layer, before any driver method runs
 * — not a substitute for real access control. A connection string with
 * write privileges can still write if something reaches the underlying
 * client directly (a driver bug, a future code path that forgets this
 * check). The one layer this app cannot bypass no matter what: connect with
 * a database role that only has SELECT granted, or point this at a read
 * replica.
 */
export declare function isReadOnlyConnection(config: ConnectionConfig): boolean;
export declare class ReadOnlyError extends Error {
    constructor(message?: string);
}
/** Call before any unconditionally-destructive operation (insertRow/updateCell/deleteRow). */
export declare function assertWritable(config: ConnectionConfig): void;
/** Call before execute() — only blocks if the query itself isn't a plain read (see isDestructiveExec). */
export declare function assertExecutable(config: ConnectionConfig, query: ExecSpec): void;
