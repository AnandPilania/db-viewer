#!/usr/bin/env node
// Assembles the publishable layout described in bin/db-viewer.js and
// static-frontend.ts:
//   <root>/server/   <- compiled apps/server/dist (plain JS, no tsx needed)
//   <root>/public/   <- built apps/web/dist (static SPA)
//
// Run automatically by `npm publish` / `npm pack` via the "prepack" script
// (see package.json). Also safe to run manually to test the published
// layout locally with `node bin/db-viewer.js`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDist = path.join(root, "apps", "server", "dist");
const webDist = path.join(root, "apps", "web", "dist");
const outServer = path.join(root, "server");
const outPublic = path.join(root, "public");

for (const [src, label] of [[serverDist, "apps/server/dist"], [webDist, "apps/web/dist"]]) {
  if (!existsSync(path.join(src, src === serverDist ? "index.js" : "index.html"))) {
    console.error(
      `Missing build output: ${label}\nRun "pnpm build" first (this should happen automatically via the "prepublishOnly" script).`
    );
    process.exit(1);
  }
}

for (const dir of [outServer, outPublic]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

cpSync(serverDist, outServer, { recursive: true });
cpSync(webDist, outPublic, { recursive: true });

console.log(`Assembled publish layout:\n  ${outServer}\n  ${outPublic}`);
