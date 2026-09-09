import { describe, expect, it } from "vitest";
import { applyRowChange } from "../apps/web/src/lib/apply-row-change.js";

const rows = () => [
  { id: 1, name: "a", total: 10 },
  { id: 2, name: "b", total: 20 },
];

/**
 * The server echoes every change back to every watcher, including the client
 * that caused it — so this must be idempotent. If it isn't, an edit the client
 * already applied optimistically gets applied a second time.
 */
describe("applyRowChange", () => {
  it("patches a single column by primary key", () => {
    const next = applyRowChange(rows(), { type: "update", primaryKey: { id: 2 }, column: "total", value: 99 }, ["id"]);
    expect(next[1].total).toBe(99);
    expect(next[0].total).toBe(10);
  });

  it("is a no-op when the value already matches (the client's own echo)", () => {
    const before = rows();
    const next = applyRowChange(before, { type: "update", primaryKey: { id: 1 }, column: "total", value: 10 }, ["id"]);
    expect(next).toBe(before); // same reference — React skips the re-render
  });

  it("matches keys across type boundaries, since JSON turns bigints into strings", () => {
    const next = applyRowChange(rows(), { type: "update", primaryKey: { id: "2" }, column: "name", value: "z" }, [
      "id",
    ]);
    expect(next[1].name).toBe("z");
  });

  it("ignores an update for a row outside the loaded window", () => {
    const before = rows();
    expect(applyRowChange(before, { type: "update", primaryKey: { id: 999 }, column: "total", value: 1 }, ["id"])).toBe(
      before
    );
  });

  it("prepends an insert", () => {
    const next = applyRowChange(rows(), { type: "insert", row: { id: 3, name: "c", total: 30 } }, ["id"]);
    expect(next).toHaveLength(3);
    expect(next[0].id).toBe(3);
  });

  it("does not duplicate an insert the client already applied optimistically", () => {
    const before = rows();
    const next = applyRowChange(before, { type: "insert", row: { id: 1, name: "a", total: 10 } }, ["id"]);
    expect(next).toBe(before);
  });

  it("removes a deleted row", () => {
    const next = applyRowChange(rows(), { type: "delete", primaryKey: { id: 1 } }, ["id"]);
    expect(next.map((r) => r.id)).toEqual([2]);
  });

  it("is a no-op when deleting a row already gone", () => {
    const before = rows();
    expect(applyRowChange(before, { type: "delete", primaryKey: { id: 42 } }, ["id"])).toBe(before);
  });

  it("replaces the whole document for Mongo's __row__ update shape", () => {
    const next = applyRowChange(
      rows(),
      { type: "update", primaryKey: { id: 1 }, column: "__row__", value: { id: 1, name: "replaced" } },
      ["id"]
    );
    expect(next[0]).toEqual({ id: 1, name: "replaced" });
    expect(next[1]).toEqual({ id: 2, name: "b", total: 20 });
  });

  it("matches on a compound primary key, all columns required", () => {
    const compound = [
      { tenant: "x", id: 1, v: "a" },
      { tenant: "y", id: 1, v: "b" },
    ];
    const next = applyRowChange(
      compound,
      { type: "update", primaryKey: { tenant: "y", id: 1 }, column: "v", value: "patched" },
      ["tenant", "id"]
    );
    expect(next[0].v).toBe("a");
    expect(next[1].v).toBe("patched");
  });

  it("refuses to guess when the primary key is only partially supplied", () => {
    const compound = [{ tenant: "x", id: 1, v: "a" }];
    // Matching on a partial key could patch the wrong tenant's row.
    expect(applyRowChange(compound, { type: "update", primaryKey: { id: 1 }, column: "v", value: "x" }, ["tenant", "id"])).toBe(
      compound
    );
  });

  it("does nothing at all without a known primary key", () => {
    const before = rows();
    expect(applyRowChange(before, { type: "delete", primaryKey: { id: 1 } }, [])).toBe(before);
  });

  it("ignores a malformed update with no column and no replacement", () => {
    const before = rows();
    expect(applyRowChange(before, { type: "update", primaryKey: { id: 1 } }, ["id"])).toBe(before);
  });
});
