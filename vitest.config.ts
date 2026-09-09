import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * One root-level suite rather than per-package configs — the things worth
 * testing here are pure logic shared across packages (keyset pagination, the
 * read-only gate, widget input validation), and none of them need a browser
 * or a live database.
 */
export default defineConfig({
  // The web app's own alias, so tests can import its modules by the same
  // specifier the app uses.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "apps/web/src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
