import { describe, expect, it } from "vitest";
import { validateWidgetInput, validateWidgetPatch } from "../apps/server/src/widget-validation.js";
import type { Widget } from "../apps/server/src/models.js";

const valid = {
  title: "Orders by status",
  connectionId: "conn_1",
  table: "orders",
  chartType: "bar",
  xField: "status",
  yField: "total",
  aggregation: "sum",
};

/**
 * These fields are concatenated into SQL by chart-query.ts — `aggregation` as
 * a function name, `schema` as a quoted identifier. The routes used to store
 * req.body unchecked, which made a saved widget a way to run arbitrary SQL.
 */
describe("validateWidgetInput", () => {
  it("accepts a well-formed widget", () => {
    const widget = validateWidgetInput(valid);
    expect(widget.table).toBe("orders");
    expect(widget.aggregation).toBe("sum");
  });

  it("rejects an aggregation outside the closed set", () => {
    expect(() => validateWidgetInput({ ...valid, aggregation: "median" })).toThrow(/aggregation/);
  });

  it("rejects SQL smuggled through aggregation", () => {
    // The injection this validation exists to stop: chart-query builds
    // `${aggregation.toUpperCase()}(col)`.
    expect(() =>
      validateWidgetInput({ ...valid, aggregation: "count(*) FROM users; DROP TABLE orders; --" })
    ).toThrow(/aggregation/);
  });

  it("rejects SQL smuggled through schema", () => {
    // quoteIdent wraps in double quotes but does not escape them, so an
    // embedded quote would break out of the identifier.
    expect(() => validateWidgetInput({ ...valid, schema: 'public" ; DROP TABLE orders; --' })).toThrow(/schema/);
  });

  it("rejects a chartType outside the closed set", () => {
    expect(() => validateWidgetInput({ ...valid, chartType: "sankey" })).toThrow(/chartType/);
  });

  it("rejects column names outside the safe identifier charset", () => {
    expect(() => validateWidgetInput({ ...valid, xField: "status; DROP TABLE orders" })).toThrow();
  });

  it("requires a yField for a non-count aggregation", () => {
    expect(() => validateWidgetInput({ ...valid, yField: undefined })).toThrow(/yField/);
  });

  it("allows count with no yField", () => {
    expect(validateWidgetInput({ ...valid, aggregation: "count", yField: undefined }).yField).toBeUndefined();
  });

  it("requires title, connectionId and table", () => {
    expect(() => validateWidgetInput({ ...valid, title: "" })).toThrow(/title/);
    expect(() => validateWidgetInput({ ...valid, connectionId: undefined })).toThrow(/connectionId/);
    expect(() => validateWidgetInput({ ...valid, table: undefined })).toThrow(/table/);
  });

  it("rejects a non-object body", () => {
    expect(() => validateWidgetInput(null)).toThrow();
    expect(() => validateWidgetInput("orders")).toThrow();
  });

  it("normalises filter values to strings and checks filter columns", () => {
    const widget = validateWidgetInput({ ...valid, filters: [{ column: "status", value: 3 }] });
    expect(widget.filters).toEqual([{ column: "status", value: "3" }]);
    expect(() => validateWidgetInput({ ...valid, filters: [{ column: "a b", value: "x" }] })).toThrow();
    expect(() => validateWidgetInput({ ...valid, filters: [{ column: "status", value: { $ne: 1 } }] })).toThrow();
  });

  it("rejects a CSS color that could carry an expression into a style attribute", () => {
    const rule = { operator: "gt", value: 1, color: "url(javascript:alert(1))" };
    expect(() => validateWidgetInput({ ...valid, highlightRules: [rule] })).toThrow(/color/);
  });

  it("accepts ordinary CSS colors in highlight rules", () => {
    for (const color of ["#f00", "#ff0000", "red", "rgb(255, 0, 0)", "rgba(255,0,0,0.5)"]) {
      const widget = validateWidgetInput({
        ...valid,
        highlightRules: [{ operator: "gte", value: 10, color }],
      });
      expect(widget.highlightRules?.[0].color).toBe(color);
    }
  });

  it("rejects a non-finite highlight threshold", () => {
    expect(() =>
      validateWidgetInput({ ...valid, highlightRules: [{ operator: "gt", value: "10", color: "red" }] })
    ).toThrow(/value/);
  });
});

describe("validateWidgetPatch", () => {
  const existing: Widget = {
    ...(validateWidgetInput(valid) as Omit<Widget, "id" | "createdAt">),
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("merges a partial patch over the existing widget", () => {
    expect(validateWidgetPatch(existing, { title: "Renamed" }).title).toBe("Renamed");
    expect(validateWidgetPatch(existing, { title: "Renamed" }).table).toBe("orders");
  });

  it("validates the merged result, so a patch cannot smuggle a bad field", () => {
    expect(() => validateWidgetPatch(existing, { aggregation: "sum(x) FROM t; --" })).toThrow(/aggregation/);
  });
});
