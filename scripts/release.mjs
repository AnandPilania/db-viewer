#!/usr/bin/env node
// Publishes the whole db-viewer package family in the only order that
// works: @pilaniaanand/driver-interface first (everything else depends on
// it), then the 6 driver packages (order doesn't matter among themselves),
// then db-viewer itself last (its package.json dependency on
// @pilaniaanand/driver-interface has to resolve on the real registry, and
// bin/db-viewer.js's `driver add` flow only makes sense once the drivers
// it references actually exist to install).
//
// Usage:
//   node scripts/release.mjs patch          bump every package patch, then publish
//   node scripts/release.mjs minor
//   node scripts/release.mjs major
//   node scripts/release.mjs 1.2.3          set every package to an exact version
//   node scripts/release.mjs --dry-run patch   show the full plan, publish nothing
//   node scripts/release.mjs --resume          re-run after a partial failure;
//                                               skips any package whose target
//                                               version is already on the registry
//
// All 7 packages (db-viewer + driver-interface + 6 drivers) are versioned
// in lockstep — same version number for all of them on every release. This
// is a deliberate simplification: db-viewer's package.json depends on
// @pilaniaanand/driver-interface via "workspace:*" in source (never hand-edit
// that field to a real version — it must stay "workspace:*" so pnpm can
// link it locally during development). pnpm publish rewrites it to an
// exact matching version automatically in the published tarball, so "what
// version of db-viewer am I running" fully answers "what version of the
// interface contract is this" for anyone who installed it from npm, with
// no separate version-matrix to track. If the drivers ever need
// independent release cadences, this script is the one place that
// assumption lives — search for LOCKSTEP below.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Publish order matters — see file header. LOCKSTEP: same version, all of them.
const PACKAGES = [
    { name: "@pilaniaanand/driver-interface", dir: "packages/driver-interface" },
    { name: "@pilaniaanand/driver-clickhouse", dir: "packages/drivers/clickhouse" },
    { name: "@pilaniaanand/driver-mongodb", dir: "packages/drivers/mongodb" },
    { name: "@pilaniaanand/driver-mysql", dir: "packages/drivers/mysql" },
    { name: "@pilaniaanand/driver-postgres", dir: "packages/drivers/postgres" },
    { name: "@pilaniaanand/driver-redis", dir: "packages/drivers/redis" },
    { name: "@pilaniaanand/driver-sqlite", dir: "packages/drivers/sqlite" },
    { name: "db-viewer", dir: "." }, // must be last — depends on the interface being live
];

function sh(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...winShellOpts(cmd), ...opts });
}

/** Runs cmd, returns { ok, reason } — reason is set (and ok is false) whether the command
 *  couldn't be spawned at all (ENOENT — usually a PATH/shim resolution problem) or ran and
 *  exited non-zero. Collapsing both into a plain boolean is what made the original version
 *  of this check impossible to debug: "pnpm not found" and "pnpm ran and failed" looked
 *  identical from the caller's side. */
function shOk(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...winShellOpts(cmd), ...opts });
    if (result.error) {
        return { ok: false, reason: `couldn't run "${cmd}" (${result.error.code ?? result.error.message})` };
    }
    if (result.status !== 0) {
        return { ok: false, reason: (result.stderr || result.stdout || `exited with code ${result.status}`).trim() };
    }
    return { ok: true, reason: null };
}

/**
 * npm/pnpm/yarn are installed as .cmd shims on Windows, not raw .exe
 * files. Two different Node behaviors bite here depending on version and
 * approach:
 *  - Bare name ("pnpm") without a shell: Node/libuv won't apply PATHEXT
 *    resolution the way a real shell does → ENOENT, command "not found"
 *    even though it works fine typed into a terminal.
 *  - Explicitly appending ".cmd" ("pnpm.cmd") WITHOUT { shell: true }:
 *    Node ≥18.20.2/20.12.2/21.7.3 (the CVE-2024-27980 fix) refuses to
 *    spawn .bat/.cmd files directly and throws EINVAL instead. This is
 *    what actually broke here — appending .cmd was the wrong half of the
 *    old fix.
 * The correct, currently-recommended combination is: keep the bare
 * command name AND pass { shell: true } on Windows only. Node's own libuv
 * PATHEXT resolution then finds the .cmd shim via cmd.exe, and args stay
 * as a real array (never concatenated into one string), which keeps the
 * usual shell-injection risk of `shell: true` off the table as long as
 * every caller here keeps passing args as an array — never build a
 * single interpolated command string.
 * See https://github.com/nodejs/node/issues/59210 and
 * https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
 */
function winShellOpts(cmd) {
    if (process.platform !== "win32") return {};
    return ["npm", "pnpm", "yarn"].includes(cmd) ? { shell: true } : {};
}

function readJson(relPath) {
    return JSON.parse(readFileSync(path.join(root, relPath), "utf8"));
}

function writeJson(relPath, data) {
    writeFileSync(path.join(root, relPath), JSON.stringify(data, null, 2) + "\n");
}

async function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

class UsageError extends Error { }

function bumpVersion(current, kind) {
    if (/^\d+\.\d+\.\d+$/.test(kind)) return kind; // exact version passed directly
    const [maj, min, patch] = current.split(".").map(Number);
    if (kind === "major") return `${maj + 1}.0.0`;
    if (kind === "minor") return `${maj}.${min + 1}.0`;
    if (kind === "patch") return `${maj}.${min}.${patch + 1}`;
    throw new UsageError(`Invalid version bump "${kind}" — use patch, minor, major, or an exact x.y.z`);
}

/** Is this exact name@version already on the npm registry? Used by --resume to skip finished work. */
function isAlreadyPublished(name, version) {
    const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
        cwd: root,
        encoding: "utf8",
        ...winShellOpts("npm"),
    });
    return result.status === 0 && result.stdout.trim() === version;
}

function currentNpmUser() {
    const result = spawnSync("npm", ["whoami"], { cwd: root, encoding: "utf8", ...winShellOpts("npm") });
    if (result.error) {
        return { user: null, reason: `couldn't run "npm" (${result.error.code ?? result.error.message})` };
    }
    if (result.status !== 0) {
        return { user: null, reason: (result.stderr || result.stdout || `exited with code ${result.status}`).trim() };
    }
    return { user: result.stdout.trim(), reason: null };
}

function preflight({ dryRun }) {
    const problems = [];

    // Clean working tree (skip check for the version-bump commit we're about to make).
    let gitAvailable = true;
    try {
        const status = sh("git", ["status", "--porcelain"]);
        if (status.trim().length > 0) {
            problems.push("Working tree isn't clean — commit or stash your changes first.");
        }
    } catch {
        gitAvailable = false;
        problems.push("Not inside a git repository (or git isn't installed) — release from a real clone, not an extracted archive.");
    }

    if (gitAvailable) {
        const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        if (branch !== "main" && branch !== "master") {
            problems.push(`On branch "${branch}", not main/master — release from the main branch.`);
        }
    }

    if (!dryRun) {
        const { user, reason } = currentNpmUser();
        if (!user) {
            problems.push(`Not logged into npm, or npm couldn't be run — ${reason}. Run "npm login" and verify "npm whoami" works in this same terminal.`);
        } else {
            console.log(`npm user: ${user}`);
        }
    }

    if (!existsSync(path.join(root, "pnpm-workspace.yaml"))) {
        problems.push("Doesn't look like the repo root (no pnpm-workspace.yaml found).");
    }

    const pnpmCheck = shOk("pnpm", ["--version"]);
    if (!pnpmCheck.ok) {
        problems.push(
            `pnpm isn't runnable — ${pnpmCheck.reason}. This script publishes via "pnpm publish" ` +
            `so workspace:* ranges get rewritten correctly; verify "pnpm --version" works in this same terminal.`
        );
    }

    return problems;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const resume = args.includes("--resume");
    const versionArg = args.find((a) => !a.startsWith("--"));

    if (!versionArg && !resume) {
        console.error("Usage: node scripts/release.mjs [--dry-run] [--resume] <patch|minor|major|x.y.z>");
        process.exit(1);
    }

    console.log(`\n${dryRun ? "[DRY RUN] " : ""}db-viewer release\n`);

    const problems = preflight({ dryRun });
    if (problems.length > 0) {
        console.error("Preflight checks failed:\n");
        for (const p of problems) console.error(`  ✗ ${p}`);
        console.error("\nFix these and try again.");
        process.exit(1);
    }
    console.log("Preflight checks passed.\n");

    // Determine the target version. On --resume (no explicit bump given),
    // reuse whatever version is currently on disk — the assumption being a
    // previous run already bumped package.json files but died partway
    // through publishing.
    const currentInterfaceVersion = readJson("packages/driver-interface/package.json").version;
    const targetVersion = versionArg ? bumpVersion(currentInterfaceVersion, versionArg) : currentInterfaceVersion;

    console.log(`Target version: ${targetVersion}\n`);

    // --- Plan ---
    const plan = PACKAGES.map((pkg) => {
        const pkgJsonPath = path.join(pkg.dir, "package.json");
        const current = readJson(pkgJsonPath).version;
        const alreadyLive = isAlreadyPublished(pkg.name, targetVersion);
        return { ...pkg, pkgJsonPath, currentVersion: current, alreadyLive };
    });

    console.log("Plan:");
    for (const p of plan) {
        const action = p.alreadyLive ? "already published — will skip" : `${p.currentVersion} -> ${targetVersion}`;
        console.log(`  ${p.name.padEnd(32)} ${action}`);
    }
    console.log("");

    if (dryRun) {
        console.log("Dry run — stopping before any writes or publishes.");
        return;
    }

    const toPublish = plan.filter((p) => !p.alreadyLive);
    if (toPublish.length === 0) {
        console.log("Everything at this version is already published. Nothing to do.");
        return;
    }

    if (!(await confirm(`Publish ${toPublish.length} package(s) at ${targetVersion}?`))) {
        console.log("Aborted.");
        return;
    }

    // --- Bump versions on disk for everything not yet published ---
    // Bumping ALL package.json files up front (not one-by-one right before
    // each publish) means a git commit captures the whole release as one
    // atomic change, and a --resume run sees consistent version numbers
    // across every package.json even if some were already published in a
    // prior attempt.
    for (const p of plan) {
        if (p.currentVersion === targetVersion) continue; // already bumped (e.g. resuming)
        const pkgJson = readJson(p.pkgJsonPath);
        pkgJson.version = targetVersion;
        writeJson(p.pkgJsonPath, pkgJson);
        console.log(`Bumped ${p.name} -> ${targetVersion}`);
    }

    // --- Publish in order, stopping (not crashing past) the first failure ---
    console.log("\nPublishing...\n");
    for (const p of toPublish) {
        console.log(`--- ${p.name} ---`);
        const result = spawnSync("pnpm", ["publish", "--no-git-checks", "--access", "public"], {
            cwd: path.join(root, p.dir),
            stdio: "inherit",
            ...winShellOpts("pnpm"),
        });
        if (result.status !== 0) {
            console.error(
                `\nPublish failed for ${p.name}. Packages published before this one are already live —\n` +
                `fix the problem and re-run with --resume to pick up where this left off (already-\n` +
                `published packages at this version will be skipped automatically).`
            );
            process.exit(1);
        }
        console.log(`✓ ${p.name}@${targetVersion} published\n`);
    }

    // --- Tag + commit the release ---
    // Packages are already live at this point — a git failure here should
    // never look like the release itself failed, just that the commit/tag
    // step needs to be done by hand.
    const addResult = spawnSync("git", ["add", "-A"], { cwd: root, stdio: "inherit" });
    if (addResult.status === 0) {
        const commitResult = spawnSync("git", ["commit", "-m", `release: v${targetVersion}`], { cwd: root, stdio: "inherit" });
        if (commitResult.status === 0) {
            spawnSync("git", ["tag", `v${targetVersion}`], { cwd: root, stdio: "inherit" });
            console.log(`\nCommitted and tagged v${targetVersion}. Don't forget: git push && git push --tags`);
        } else {
            console.log(`\nPackages published, but "git commit" failed — commit and tag v${targetVersion} manually.`);
        }
    } else {
        console.log(`\nPackages published, but "git add" failed — commit and tag v${targetVersion} manually.`);
    }

    console.log(`\nDone. All ${toPublish.length} package(s) published at ${targetVersion}.`);
    console.log(`\nSanity check:\n  npx db-viewer@${targetVersion}\n  db-viewer driver add postgres`);
}

main().catch((err) => {
    if (err instanceof UsageError) {
        console.error(`\n${err.message}`);
        process.exit(1);
    }
    console.error("\nRelease script crashed:", err);
    process.exit(1);
});
