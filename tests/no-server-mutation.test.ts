import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (driver: string) => readFileSync(`packages/drivers/${driver}/src/index.ts`, "utf-8");

/**
 * Opening a table must not change the customer's database. Postgres CDC is a
 * trigger (a schema change, visible to an auditor, firing on every write from
 * every application) and Redis CDC is a server-global CONFIG SET affecting
 * every other client of the instance — both are change-control violations in
 * a regulated environment when done implicitly.
 *
 * This is a source-level guard on purpose: the regression it exists to catch
 * is someone adding a convenient "just install it" path back, which no
 * behavioural test would notice until it ran against production.
 */
const MUTATES_SERVER = [/CREATE\s+TRIGGER/i, /CREATE\s+OR\s+REPLACE\s+FUNCTION/i, /configSet\(/];

describe("drivers do not modify the target server without opt-in", () => {
  it.each(["mysql", "sqlite", "clickhouse", "mongodb"])("%s never mutates the server at all", (driver) => {
    const src = read(driver);
    for (const pattern of MUTATES_SERVER) expect(src).not.toMatch(pattern);
  });

  it("postgres gates its trigger DDL behind installCdc and defaults to polling", () => {
    const src = read("postgres");
    expect(src).toMatch(/CREATE\s+TRIGGER/i); // the opt-in path still exists
    expect(src).toContain("if (!this.installCdc) return this.watchByPolling");
    // The flag can never be on for a connection the user marked read-only.
    expect(src).toContain("this.installCdc = installCdc && !readOnly");
  });

  it("redis only runs CONFIG SET under installCdc", () => {
    const src = read("redis");
    // The only CONFIG SET that turns notifications ON sits behind this gate;
    // the other one is the restore-on-close, which can only fire if the gated
    // branch ran first.
    expect(src).toContain('if (this.installCdc && (!currentValue.includes("E")');
    expect(src.match(/configSet\(/g)).toHaveLength(2);
  });
});
