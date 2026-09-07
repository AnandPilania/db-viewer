import type { DatabaseDriver } from "@pilaniaanand/driver-interface";
import { driversDir } from "./driver-home.js";
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
declare class DriverRegistry {
    private drivers;
    private unavailable;
    register(driver: DatabaseDriver): void;
    get(key: string): DatabaseDriver;
    list(): Array<{
        key: string;
        displayName: string;
        capabilities: DatabaseDriver["capabilities"];
    }>;
    /** Drivers whose package name is known but couldn't be resolved via either strategy above. */
    listUnavailable(): Array<{
        key: string;
        packageName: string;
        displayName: string;
    }>;
    /**
     * Attempts to load every known driver package. Call once at startup
     * before the server starts accepting requests. Safe to call multiple
     * times (re-discovers from scratch each time — used after `driver
     * add`/`driver remove` too, so a running dev server can pick up changes
     * without a restart).
     */
    discover(): Promise<void>;
}
export declare const registry: DriverRegistry;
export { driversDir };
