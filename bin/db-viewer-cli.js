#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

// Published layout (what `npm install db-viewer` / `npx db-viewer` runs):
//   <package>/server/index.js   <- compiled server, plain JS, no tsx needed
//   <package>/public/index.html <- pre-built web app, served by the server itself
// Monorepo dev layout (what running this script from a `git clone` looks
// like before a release build has been made): neither of the above exist
// yet, so we fall back to running the TypeScript source directly via tsx,
// same as before this file supported publishing.
const serverEntry = path.join(packageRoot, "server", "index.js");
const isPublishedBuild = existsSync(serverEntry);

// Fixed home for installed drivers, independent of cwd or how db-viewer
// itself was installed — see apps/server/src/driver-home.ts for why this
// can't just be "the nearest node_modules". Both this CLI and the server
// process (via driver-home.ts) resolve drivers from the exact same place.
const driverHome = process.env.DB_VIEWER_HOME ?? path.join(os.homedir(), ".db-viewer");
const driversDir = path.join(driverHome, "drivers");

const KNOWN_DRIVERS = {
  sqlite: "@db-viewer/driver-sqlite",
  postgres: "@db-viewer/driver-postgres",
  mysql: "@db-viewer/driver-mysql",
  mongodb: "@db-viewer/driver-mongodb",
  redis: "@db-viewer/driver-redis",
  clickhouse: "@db-viewer/driver-clickhouse",
};

/**
 * npm is installed as a .cmd shim on Windows, not a raw .exe. Two
 * different failure modes depending on approach:
 *  - Bare "npm" without a shell: Node won't apply PATHEXT resolution the
 *    way a real shell does -> ENOENT, even though it works fine typed
 *    into a terminal.
 *  - Explicitly appending ".cmd" WITHOUT { shell: true }: Node
 *    >=18.20.2/20.12.2/21.7.3 (the CVE-2024-27980 fix) refuses to spawn
 *    .bat/.cmd files directly and throws EINVAL instead.
 * The fix is the bare command name PLUS { shell: true } on Windows only.
 * Args stay a real array (never concatenated into one string), so the
 * usual shell-injection risk of shell:true doesn't apply here.
 * See https://github.com/nodejs/node/issues/59210 and
 * https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
 */
function winShellOpts(cmd) {
  if (!isWindows) return {};
  return ["npm", "pnpm", "yarn"].includes(cmd) ? { shell: true } : {};
}

function runSync(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", ...winShellOpts(cmd) });
  if (result.error) {
    console.error(`Failed to run ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureDriversDirInitialized() {
  if (existsSync(driversDir)) return;
  mkdirSync(driversDir, { recursive: true });
  // A package.json makes this a real npm project directory, so
  // `npm install <driver>` here behaves normally (lockfile, node_modules,
  // dedup) instead of complaining it's not inside a project.
  runSync("npm", ["init", "-y", "--silent"], driversDir);
}

function driverAdd(name) {
  const pkg = KNOWN_DRIVERS[name];
  if (!pkg) {
    console.error(`Unknown driver "${name}". Known drivers: ${Object.keys(KNOWN_DRIVERS).join(", ")}\n`);
    process.exit(1);
  }
  ensureDriversDirInitialized();
  console.log(`Installing ${pkg} into ${driversDir}...\n`);
  // better-sqlite3 and similar native drivers may still need a compiler
  // toolchain on the host machine — that's inherent to those drivers, not
  // something db-viewer can avoid. The point of this split is that you
  // only pay that cost for drivers you actually asked for.
  runSync("npm", ["install", pkg], driversDir);
  console.log(`\nDone. "${name}" will be available next time you run db-viewer.`);
}

function driverRemove(name) {
  const pkg = KNOWN_DRIVERS[name];
  if (!pkg) {
    console.error(`Unknown driver "${name}". Known drivers: ${Object.keys(KNOWN_DRIVERS).join(", ")}\n`);
    process.exit(1);
  }
  if (!existsSync(driversDir)) {
    console.log(`No drivers installed yet.`);
    return;
  }
  console.log(`Removing ${pkg} from ${driversDir}...\n`);
  runSync("npm", ["uninstall", pkg], driversDir);
}

function driverList() {
  console.log(`Drivers (installed under ${driversDir}):\n`);
  for (const [name, pkg] of Object.entries(KNOWN_DRIVERS)) {
    const installed = existsSync(path.join(driversDir, "node_modules", ...pkg.split("/")));
    console.log(`  ${installed ? "✓" : " "} ${name.padEnd(12)} ${pkg}${installed ? "" : "  (not installed)"}`);
  }
  console.log(`\nAdd one with: db-viewer driver add <name>`);
}

function printDriverHelp() {
  console.log(
    "Usage:\n" +
      "  db-viewer driver list               Show installed & available drivers\n" +
      "  db-viewer driver add <name>         Install a driver (e.g. postgres, sqlite)\n" +
      "  db-viewer driver remove <name>      Uninstall a driver\n\n" +
      `Known drivers: ${Object.keys(KNOWN_DRIVERS).join(", ")}\n`
  );
}

function handleDriverCommand(args) {
  const [sub, name] = args;
  if (sub === "list" && !name) return driverList();
  if (sub === "add" && name) return driverAdd(name);
  if (sub === "remove" && name) return driverRemove(name);
  printDriverHelp();
  process.exit(sub ? 1 : 0);
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : isWindows ? "cmd" : "xdg-open";
  const args = isWindows ? ["/c", "start", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Best-effort only — the printed URL is the real fallback.
  }
}

function startPublished() {
  const port = process.env.PORT || "4000";
  const url = `http://localhost:${port}`;
  console.log(`Starting DB Viewer at ${url}\n`);

  const server = spawn(process.execPath, [serverEntry], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, PORT: port, DB_VIEWER_HOME: driverHome },
  });

  server.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => server.kill("SIGINT"));
  process.on("SIGTERM", () => server.kill("SIGTERM"));

  if (!process.env.DB_VIEWER_NO_OPEN) setTimeout(() => openBrowser(url), 1200);
}

function startMonorepoDev() {
  // Only reachable when running straight from a git clone before a release
  // build exists — see isPublishedBuild above. Requires `pnpm install` to
  // have been run at the repo root first.
  const webDir = path.join(packageRoot, "apps", "web");
  const serverDir = path.join(packageRoot, "apps", "server");
  const webDist = path.join(webDir, "dist");

  const missing = [webDir, serverDir].filter((dir) => !existsSync(path.join(dir, "node_modules")));
  if (missing.length > 0) {
    console.error("Dependencies aren't installed yet. From the repo root, run:\n\n  pnpm install\n");
    process.exit(1);
  }

  function localBin(pkgDir, name) {
    return path.join(pkgDir, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);
  }

  if (!existsSync(path.join(webDist, "index.html"))) {
    console.log("Building the frontend (first run only)...\n");
    runSync(localBin(webDir, "vite"), ["build"], webDir);
    console.log("");
  }

  const port = process.env.PORT || "4000";
  const url = `http://localhost:${port}`;
  console.log(`Starting DB Viewer (dev mode) at ${url}\n`);

  const server = spawn(localBin(serverDir, "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    stdio: "inherit",
    env: { ...process.env, PORT: port, DB_VIEWER_HOME: driverHome },
  });

  server.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => server.kill("SIGINT"));
  process.on("SIGTERM", () => server.kill("SIGTERM"));

  if (!process.env.DB_VIEWER_NO_OPEN) setTimeout(() => openBrowser(url), 1200);
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === "driver") {
    return handleDriverCommand(args.slice(1));
  }

  if (isPublishedBuild) startPublished();
  else startMonorepoDev();
}

main();
