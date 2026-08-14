import type { DatabaseDriver } from "@db-viewer/driver-interface";
import { sqliteDriver } from "@db-viewer/driver-sqlite";
import { postgresDriver } from "@db-viewer/driver-postgres";
import { mysqlDriver } from "@db-viewer/driver-mysql";
import { mongodbDriver } from "@db-viewer/driver-mongodb";

/**
 * Adding a new database = write a package implementing DatabaseDriver, then
 * add one line here. Nothing else in the server needs to change.
 */
class DriverRegistry {
    private drivers = new Map<string, DatabaseDriver>();

    register(driver: DatabaseDriver) {
        this.drivers.set(driver.key, driver);
    }

    get(key: string): DatabaseDriver {
        const driver = this.drivers.get(key);
        if (!driver) {
            throw new Error(`No driver registered for "${key}". Available: ${[...this.drivers.keys()].join(", ")}`);
        }
        return driver;
    }

    list(): Array<{ key: string; displayName: string; capabilities: DatabaseDriver["capabilities"] }> {
        return [...this.drivers.values()].map((d) => ({ key: d.key, displayName: d.displayName, capabilities: d.capabilities }));
    }
}

export const registry = new DriverRegistry();
registry.register(sqliteDriver);
registry.register(postgresDriver);
registry.register(mysqlDriver);
registry.register(mongodbDriver);
