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
const nativeWatchers = new Map();
export async function ensureNativeWatch(connectionId, table) {
    const key = `${connectionId}::${table}`;
    const existing = nativeWatchers.get(key);
    if (existing) {
        existing.count++;
        await existing.ready;
        return;
    }
    const entry = {
        count: 1,
        ready: (async () => {
            const conn = await connectionStore.getLive(connectionId);
            if (!conn.watchTable)
                return null; // driver doesn't support native watching
            const stop = conn.watchTable(table, undefined, (event) => {
                try {
                    tableEvents.publish(connectionId, table, event);
                }
                catch (err) {
                    logger.error({ err, connectionId, table }, "Native-watch callback failed");
                }
            });
            return { stop };
        })(),
    };
    nativeWatchers.set(key, entry);
    try {
        await entry.ready;
    }
    catch (err) {
        // Connection not available yet — app-originated events still work via
        // tableEvents. Drop the entry so a later subscriber retries instead of
        // inheriting a permanently-failed watcher.
        if (nativeWatchers.get(key) === entry)
            nativeWatchers.delete(key);
        logger.warn({ err, connectionId, table }, "Could not start native table watch");
    }
}
export function releaseNativeWatch(connectionId, table) {
    const key = `${connectionId}::${table}`;
    const entry = nativeWatchers.get(key);
    if (!entry)
        return;
    entry.count--;
    if (entry.count > 0)
        return;
    nativeWatchers.delete(key);
    // The handle may still be in flight; stop it once it lands either way.
    entry.ready.then((handle) => handle?.stop()).catch(() => { });
}
//# sourceMappingURL=table-events.js.map