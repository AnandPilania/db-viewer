import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
export function driverHomeDir(): string {
  return process.env.DB_VIEWER_HOME ?? path.join(os.homedir(), ".db-viewer");
}

export function driversDir(): string {
  return path.join(driverHomeDir(), "drivers");
}

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
export async function resolveInstalledDriver(packageName: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const pkgDir = path.join(driversDir(), "node_modules", ...packageName.split("/"));
  const pkgJsonPath = path.join(pkgDir, "package.json");

  try {
    await fs.access(pkgJsonPath);
  } catch {
    return null; // not installed
  }

  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
  const entry = pkgJson.main ?? "index.js";
  return pathToFileURL(path.join(pkgDir, entry)).href;
}
