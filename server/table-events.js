import { EventEmitter } from "node:events";
import { connectionStore } from "./connection-store.js";
import { logger } from "./logger.js";
/**
 * Every mutation route (insert/update/delete) publishes here after a
 * successful write; every open "watch" WebSocket subscribes here. This is
 * what makes the UI update instantly across tabs/users when someone edits
 * data through the app itself.
 *
 * `ensureNativeWatch` below also feeds each driver's own change detection
 * into this same bus, so writes made *outside* the app are picked up too:
 * Postgres (auto-installed trigger + LISTEN/NOTIFY), Redis (keyspace
 * notifications), MongoDB (Change Streams), and SQLite/MySQL/ClickHouse
 * (poll-and-diff — none of the three have a low-effort native push
 * mechanism, so they re-check the table on an interval instead).
 */
class TableEventBus extends EventEmitter {
    key(connectionId, table) {
        return `${connectionId}::${table}`;
    }
    publish(connectionId, table, event) {
        this.emit(this.key(connectionId, table), event);
    }
    subscribe(connectionId, table, handler) {
        const key = this.key(connectionId, table);
        this.on(key, handler);
        return () => this.off(key, handler);
    }
}
export const tableEvents = new TableEventBus();
tableEvents.setMaxListeners(0); // unbounded — many browser tabs may watch the same table
// Refcounted so we only open one native change stream/listener per
// (connection, table) no matter how many subscribers (browser tabs, embed
// viewers) are watching it, and close it the moment nobody is.
const nativeWatchers = new Map();
export async function ensureNativeWatch(connectionId, table) {
    const key = `${connectionId}::${table}`;
    const existing = nativeWatchers.get(key);
    if (existing) {
        existing.count++;
        return;
    }
    try {
        const conn = await connectionStore.getLive(connectionId);
        if (!conn.watchTable)
            return; // driver doesn't support native watching
        const stop = conn.watchTable(table, undefined, (event) => {
            try {
                tableEvents.publish(connectionId, table, event);
            }
            catch (err) {
                logger.error({ err, connectionId, table }, "Native-watch callback failed");
            }
        });
        nativeWatchers.set(key, { count: 1, stop });
    }
    catch (err) {
        // Connection not available yet — app-originated events still work via tableEvents.
        logger.warn({ err, connectionId, table }, "Could not start native table watch");
    }
}
export function releaseNativeWatch(connectionId, table) {
    const key = `${connectionId}::${table}`;
    const existing = nativeWatchers.get(key);
    if (!existing)
        return;
    existing.count--;
    if (existing.count <= 0) {
        existing.stop();
        nativeWatchers.delete(key);
    }
}
//# sourceMappingURL=table-events.js.map