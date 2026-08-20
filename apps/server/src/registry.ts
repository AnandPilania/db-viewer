import type { DatabaseDriver } from "@pilaniaanand/driver-interface";
import { resolveInstalledDriver, driversDir } from "./driver-home.js";

/**
 * Every driver db-viewer knows how to load, keyed by its registry key.
 * The npm package name follows a fixed convention: `@pilaniaanand/driver-<key>`.
 * None of these are imported here directly — see `discover()`.
 */
const KNOWN_DRIVERS: Record<string, { packageName: string; exportName: string; displayName: string }> = {
    sqlite: { packageName: "@pilaniaanand/driver-sqlite", exportName: "sqliteDriver", displayName: "SQLite" },
    postgres: { packageName: "@pilaniaanand/driver-postgres", exportName: "postgresDriver", displayName: "PostgreSQL" },
    mysql: { packageName: "@pilaniaanand/driver-mysql", exportName: "mysqlDriver", displayName: "MySQL" },
    mongodb: { packageName: "@pilaniaanand/driver-mongodb", exportName: "mongodbDriver", displayName: "MongoDB" },
    redis: { packageName: "@pilaniaanand/driver-redis", exportName: "redisDriver", displayName: "Redis" },
    clickhouse: { packageName: "@pilaniaanand/driver-clickhouse", exportName: "clickhouseDriver", displayName: "ClickHouse" },
};

/**
 * Adding a new database = write a package implementing DatabaseDriver,
 * publish it as `@pilaniaanand/driver-<key>`, and add one line to
 * KNOWN_DRIVERS above. Nothing else in the server needs to change.
 *
 * Drivers are NOT static dependencies of this package. Each one is looked
 * up at startup via TWO resolution strategies, tried in order:
 *
 *  1. Normal Node module resolution (`import(packageName)`), which walks
 *     up node_modules from wherever this compiled file lives. This is
 *     what makes local development work: in the monorepo, drivers are
 *     `optionalDependencies` of apps/server, so `pnpm install` links them
 *     straight into apps/server/node_modules and this resolves them for
 *     free — the same as any other npm dependency.
 *
 *  2. The fixed driversDir() home (~/.db-viewer/drivers by default — see
 *     driver-home.ts), used by `db-viewer driver add`. This is what makes
 *     `npx db-viewer` / a global install work: in that context there is no
 *     monorepo and no node_modules relationship between db-viewer and
 *     anything the user installs, so strategy 1 can never find anything,
 *     and drivers need a fixed, well-known location instead.
 *
 * Both are tried on every driver so either workflow (or a hybrid — e.g.
 * someone running the published CLI from a project that also happens to
 * have the driver as a real dependency) works without extra configuration.
 */
class DriverRegistry {
    private drivers = new Map<string, DatabaseDriver>();
    private unavailable: string[] = [];

    register(driver: DatabaseDriver) {
        this.drivers.set(driver.key, driver);
    }

    get(key: string): DatabaseDriver {
        const driver = this.drivers.get(key);
        if (!driver) {
            const known = KNOWN_DRIVERS[key];
            if (known && this.unavailable.includes(key)) {
                throw new Error(`The "${key}" driver isn't installed. Run: db-viewer driver add ${key}`);
            }
            throw new Error(`No driver registered for "${key}". Available: ${[...this.drivers.keys()].join(", ")}`);
        }
        return driver;
    }

    list(): Array<{ key: string; displayName: string; capabilities: DatabaseDriver["capabilities"] }> {
        return [...this.drivers.values()].map((d) => ({ key: d.key, displayName: d.displayName, capabilities: d.capabilities }));
    }

    /** Drivers whose package name is known but couldn't be resolved via either strategy above. */
    listUnavailable(): Array<{ key: string; packageName: string; displayName: string }> {
        return this.unavailable.map((key) => ({ key, ...KNOWN_DRIVERS[key] }));
    }

    /**
     * Attempts to load every known driver package. Call once at startup
     * before the server starts accepting requests. Safe to call multiple
     * times (re-discovers from scratch each time — used after `driver
     * add`/`driver remove` too, so a running dev server can pick up changes
     * without a restart).
     */
    async discover(): Promise<void> {
        this.drivers.clear();
        this.unavailable = [];

        for (const [key, meta] of Object.entries(KNOWN_DRIVERS)) {
            const attempts: Array<{ label: string; load: () => Promise<any> }> = [
                { label: "node_modules", load: () => import(/* @vite-ignore */ meta.packageName) },
                {
                    label: "driversDir",
                    load: async () => {
                        const entryUrl = await resolveInstalledDriver(meta.packageName);
                        if (!entryUrl) {
                            const err: any = new Error(`Cannot find package '${meta.packageName}' under driversDir()`);
                            err.code = "ERR_MODULE_NOT_FOUND";
                            throw err;
                        }
                        return import(/* @vite-ignore */ entryUrl);
                    },
                },
            ];

            let lastError: any = null;
            let loaded = false;

            for (const attempt of attempts) {
                try {
                    const mod: any = await attempt.load();
                    const driver = mod[meta.exportName] as DatabaseDriver | undefined;
                    if (!driver) {
                        throw new Error(`${meta.packageName} did not export "${meta.exportName}" (found: ${Object.keys(mod).join(", ") || "nothing"})`);
                    }
                    this.register(driver);
                    loaded = true;
                    break;
                } catch (err: any) {
                    lastError = err;
                    const notFound =
                        (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") &&
                        String(err?.message ?? "").includes(meta.packageName);
                    if (!notFound) {
                        // Found the package via this strategy but loading it still
                        // failed — unbuilt dist/, a missing native binding, a broken
                        // dependency inside the driver itself, etc. That's a real bug,
                        // not a "try the next strategy" situation, so stop here and
                        // report it loudly rather than silently falling through.
                        break;
                    }
                    // else: not found via this strategy, fall through to the next one
                }
            }

            if (!loaded) {
                const notFoundEverywhere =
                    (lastError?.code === "ERR_MODULE_NOT_FOUND" || lastError?.code === "MODULE_NOT_FOUND") &&
                    String(lastError?.message ?? "").includes(meta.packageName);
                if (!notFoundEverywhere) {
                    console.error(`[db-viewer] Driver "${key}" (${meta.packageName}) failed to load:\n${lastError?.stack ?? lastError?.message ?? lastError}`);
                }
                this.unavailable.push(key);
            }
        }
    }
}

export const registry = new DriverRegistry();
export { driversDir };
