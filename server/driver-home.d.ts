/**
 * Where `db-viewer driver add <name>` installs driver packages, and where
 * this process looks for them at startup — independent of process.cwd()
 * or where the db-viewer CLI itself was installed.
 *
 * This matters specifically for `npx db-viewer` and `npm install -g
 * db-viewer`: in both cases the running code lives inside an npm/npx
 * cache directory that has nothing to do with the user's project folder,
 * so Node's normal upward node_modules resolution can't find a driver
 * installed anywhere the user would expect (their cwd, their project).
 * A fixed, well-known home directory — the same pattern nvm/pnpm/etc use
 * for their own state — sidesteps that entirely: `driver add` always
 * installs here, and this process always looks here, regardless of how
 * db-viewer itself was invoked.
 *
 * Override with DB_VIEWER_HOME for testing or a non-default location.
 */
export declare function driverHomeDir(): string;
export declare function driversDir(): string;
/**
 * Resolves an installed driver package's entry point as a file:// URL
 * suitable for dynamic import() — bypassing Node's ambient module
 * resolution (which only walks up from *this file's own location*, i.e.
 * wherever db-viewer itself is installed, not driversDir()).
 *
 * Returns null if the package isn't present under driversDir() at all
 * (the "not installed" case) — a package.json read/parse failure for a
 * package that IS present is thrown, since that's a real corruption bug,
 * not a "please install this" situation.
 */
export declare function resolveInstalledDriver(packageName: string): Promise<string | null>;
