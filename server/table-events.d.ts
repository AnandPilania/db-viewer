import { EventEmitter } from "node:events";
import type { RowChangeEvent } from "@pilaniaanand/driver-interface";
export type TableChangeEvent = RowChangeEvent;
/**
 * Every mutation route (insert/update/delete) publishes here after a
 * successful write; every open "watch" WebSocket subscribes here. This is
 * what makes the UI update instantly across tabs/users when someone edits
 * data through the app itself.
 *
 * `ensureNativeWatch` below also feeds each driver's own change detection
 * into this same bus, so writes made *outside* the app are picked up too:
 * MongoDB (Change Streams) and SQLite/MySQL/ClickHouse/Postgres
 * (poll-and-diff on an interval).
 *
 * Postgres (trigger + LISTEN/NOTIFY) and Redis (keyspace notifications) can
 * do better, but both need us to modify the target server to get there, so
 * they are opt-in per connection via `installCdc` and fall back to the
 * read-only paths above. See ConnectionConfig.installCdc.
 */
declare class TableEventBus extends EventEmitter {
    private key;
    publish(connectionId: string, table: string, event: TableChangeEvent): void;
    subscribe(connectionId: string, table: string, handler: (event: TableChangeEvent) => void): () => void;
}
export declare const tableEvents: TableEventBus;
export declare function ensureNativeWatch(connectionId: string, table: string): Promise<void>;
export declare function releaseNativeWatch(connectionId: string, table: string): void;
export {};
