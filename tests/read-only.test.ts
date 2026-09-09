import { afterEach, describe, expect, it } from "vitest";
import { isDestructiveExec } from "@pilaniaanand/driver-interface";
import { assertExecutable, assertWritable, isReadOnlyConnection, ReadOnlyError } from "../apps/server/src/read-only.js";
import type { ConnectionConfig } from "@pilaniaanand/driver-interface";

const base: ConnectionConfig = { id: "c1", driver: "postgres", name: "test" } as ConnectionConfig;

afterEach(() => {
  delete process.env.DB_VIEWER_READ_ONLY;
});

describe("isReadOnlyConnection", () => {
  it("honours the per-connection flag", () => {
    expect(isReadOnlyConnection(base)).toBe(false);
    expect(isReadOnlyConnection({ ...base, readOnly: true })).toBe(true);
  });

  it("honours the global override regardless of the connection", () => {
    process.env.DB_VIEWER_READ_ONLY = "true";
    expect(isReadOnlyConnection(base)).toBe(true);
  });

  it("treats any value other than the exact string 'true' as off", () => {
    process.env.DB_VIEWER_READ_ONLY = "1";
    expect(isReadOnlyConnection(base)).toBe(false);
  });
});

describe("assertWritable", () => {
  it("blocks writes on a read-only connection", () => {
    expect(() => assertWritable({ ...base, readOnly: true })).toThrow(ReadOnlyError);
  });

  it("allows writes otherwise", () => {
    expect(() => assertWritable(base)).not.toThrow();
  });
});

describe("assertExecutable", () => {
  const select = { language: "sql", sql: "SELECT * FROM orders" } as const;
  const drop = { language: "sql", sql: "DROP TABLE orders" } as const;

  it("allows a plain read on a read-only connection", () => {
    expect(() => assertExecutable({ ...base, readOnly: true }, select)).not.toThrow();
  });

  it("blocks a destructive statement on a read-only connection", () => {
    expect(() => assertExecutable({ ...base, readOnly: true }, drop)).toThrow(ReadOnlyError);
  });

  it("allows a destructive statement on a writable connection", () => {
    expect(() => assertExecutable(base, drop)).not.toThrow();
  });
});

/**
 * The gate is only as good as this classifier — anything it calls a read runs
 * unchecked against a connection the user marked read-only.
 */
describe("isDestructiveExec", () => {
  it("classifies reads as non-destructive", () => {
    for (const sql of ["SELECT 1", "  select * from t", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN SELECT 1"]) {
      expect(isDestructiveExec({ language: "sql", sql })).toBe(false);
    }
  });

  it("classifies writes and DDL as destructive", () => {
    for (const sql of [
      "DELETE FROM orders",
      "UPDATE orders SET total = 0",
      "INSERT INTO orders VALUES (1)",
      "DROP TABLE orders",
      "TRUNCATE orders",
      "ALTER TABLE orders ADD COLUMN x int",
      "CREATE TABLE t (id int)",
    ]) {
      expect(isDestructiveExec({ language: "sql", sql })).toBe(true);
    }
  });
});
