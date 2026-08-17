#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webDir = path.join(repoRoot, "apps", "web");
const serverDir = path.join(repoRoot, "apps", "server");
const webDist = path.join(webDir, "dist");
const isWindows = process.platform === "win32";

function localBin(pkgDir, name) {
    return path.join(pkgDir, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);
}

function runSync(cmd, args, cwd) {
    const result = spawnSync(cmd, args, {
        cwd,
        stdio: "inherit",
        shell: isWindows
    });
    if (result.error) {
        console.error(`Failed to run ${cmd}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function checkInstalled() {
    const missing = [webDir, serverDir].filter((dir) => !existsSync(path.join(dir, "node_modules")));
    if (missing.length > 0) {
        console.error(
            "Dependencies aren't installed yet. From the repo root, run:\n\n" +
            "  pnpm install\n\n" +
            "then re-run this command (or `npx .`).\n"
        );
        process.exit(1);
    }
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

function main() {
    checkInstalled();

    if (!existsSync(path.join(webDist, "index.html"))) {
        console.log("Building the frontend (first run only — subsequent starts skip this)...\n");
        runSync(localBin(webDir, "vite"), ["build"], webDir);
        console.log("");
    }

    const port = process.env.PORT || "4000";
    const url = `http://localhost:${port}`;
    console.log(`Starting DB Viewer at ${url}\n`);

    const server = spawn(localBin(serverDir, "tsx"), ["src/index.ts"], {
        cwd: serverDir,
        stdio: "inherit",
        shell: isWindows,
        env: { ...process.env, PORT: port },
    });

    server.on("exit", (code) => process.exit(code ?? 0));
    process.on("SIGINT", () => server.kill("SIGINT"));
    process.on("SIGTERM", () => server.kill("SIGTERM"));

    if (!process.env.DB_VIEWER_NO_OPEN) {
        setTimeout(() => openBrowser(url), 1200);
    }
}

main();
