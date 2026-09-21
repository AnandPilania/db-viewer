import { describe, expect, it } from "vitest";
import { compileFilterMatch, compileFilters, flattenFilters, type FilterNode } from "@pilaniaanand/driver-interface";

/** Stands in for a driver with a real binder: values go to params, SQL gets a placeholder. */
function pg(nodes: FilterNode[] | undefined) {
    const params: unknown[] = [];
    const sql = compileFilters(nodes, {
        quote: (id) => `"${id}"`,
        bind: (value) => {
            params.push(value);
            return `$${params.length}`;
        },
    });
    return { sql, params };
}

describe("compileFilters", () => {
    it("joins the top level with AND", () => {
        expect(
            pg([
                { column: "status", op: "=", value: "paid" },
                { column: "total", op: ">", value: 100 },
            ])
        ).toEqual({ sql: `"status" = $1 AND "total" > $2`, params: ["paid", 100] });
    });

    it("parenthesises an OR group so it can't swallow the surrounding AND", () => {
        const { sql, params } = pg([
            { column: "active", op: "=", value: true },
            {
                combinator: "or",
                conditions: [
                    { column: "region", op: "=", value: "east" },
                    { column: "region", op: "=", value: "west" },
                ],
            },
        ]);
        expect(sql).toBe(`"active" = $1 AND ("region" = $2 OR "region" = $3)`);
        expect(params).toEqual([true, "east", "west"]);
    });

    it("nests groups to any depth", () => {
        const { sql } = pg([
            {
                combinator: "or",
                conditions: [
                    { column: "a", op: "=", value: 1 },
                    {
                        combinator: "and",
                        conditions: [
                            { column: "b", op: "=", value: 2 },
                            { column: "c", op: "=", value: 3 },
                        ],
                    },
                ],
            },
        ]);
        expect(sql).toBe(`("a" = $1 OR ("b" = $2 AND "c" = $3))`);
    });

    it("expands IN and emits null checks without a value", () => {
        expect(pg([{ column: "id", op: "in", value: [1, 2, 3] }])).toEqual({
            sql: `"id" IN ($1, $2, $3)`,
            params: [1, 2, 3],
        });
        expect(pg([{ column: "deleted_at", op: "is_null" }])).toEqual({ sql: `"deleted_at" IS NULL`, params: [] });
    });

    it("compiles an empty IN to a false predicate rather than invalid SQL", () => {
        expect(pg([{ column: "id", op: "in", value: [] }]).sql).toBe("1 = 0");
    });

    it("supplies the wildcards for contains/starts with/ends with", () => {
        expect(pg([{ column: "name", op: "contains", value: "ana" }])).toEqual({
            sql: `"name" LIKE $1 ESCAPE '\\'`,
            params: ["%ana%"],
        });
        expect(pg([{ column: "name", op: "starts_with", value: "an" }]).params).toEqual(["an%"]);
        expect(pg([{ column: "name", op: "ends_with", value: "na" }]).params).toEqual(["%na"]);
    });

    it("escapes wildcards inside the user's own text", () => {
        // Searching for "50%" must not mean "50 followed by anything".
        expect(pg([{ column: "label", op: "contains", value: "50%_x" }]).params).toEqual(["%50\\%\\_x%"]);
        // A raw `like` pattern is the user's to write — left untouched.
        expect(pg([{ column: "label", op: "like", value: "50%" }])).toEqual({
            sql: `"label" LIKE $1`,
            params: ["50%"],
        });
    });

    it("negates and ranges", () => {
        expect(pg([{ column: "name", op: "not_contains", value: "x" }]).sql).toBe(`"name" NOT LIKE $1 ESCAPE '\\'`);
        expect(pg([{ column: "id", op: "not_in", value: [1, 2] }]).sql).toBe(`"id" NOT IN ($1, $2)`);
        expect(pg([{ column: "id", op: "between", value: [1, 9] }])).toEqual({
            sql: `"id" BETWEEN $1 AND $2`,
            params: [1, 9],
        });
        // NOT IN () excludes nothing, which is the opposite of IN ().
        expect(pg([{ column: "id", op: "not_in", value: [] }]).sql).toBe("1 = 1");
    });

    it("returns nothing for an empty or absent tree", () => {
        expect(pg(undefined).sql).toBe("");
        expect(pg([{ combinator: "and", conditions: [] }]).sql).toBe("");
    });

    it("rejects a forged operator, combinator, or column", () => {
        expect(() => pg([{ column: "id", op: "; DROP TABLE users --" as never, value: 1 }])).toThrow(/operator/);
        expect(() => pg([{ combinator: "; --" as never, conditions: [{ column: "id", op: "=", value: 1 }] }])).toThrow(
            /combinator/
        );
        expect(() => pg([{ column: 'id" = 1 OR "1', op: "=", value: 1 }])).toThrow();
    });
});

describe("compileFilterMatch", () => {
    it("maps a nested tree onto $and/$or", () => {
        expect(
            compileFilterMatch([
                { column: "active", op: "=", value: true },
                {
                    combinator: "or",
                    conditions: [
                        { column: "region", op: "=", value: "east" },
                        { column: "score", op: ">=", value: 10 },
                    ],
                },
            ])
        ).toEqual({
            $and: [{ active: { $eq: true } }, { $or: [{ region: { $eq: "east" } }, { score: { $gte: 10 } }] }],
        });
    });

    it("maps the text operators onto anchored regexes", () => {
        expect(compileFilterMatch([{ column: "name", op: "starts_with", value: "a.b" }])).toEqual({
            name: { $regex: "^a\\.b", $options: "i" },
        });
        expect(compileFilterMatch([{ column: "id", op: "between", value: [1, 9] }])).toEqual({
            id: { $gte: 1, $lte: 9 },
        });
        expect(compileFilterMatch([{ column: "id", op: "not_in", value: [1] }])).toEqual({ id: { $nin: [1] } });
    });

    it("has no $and to add for a single condition", () => {
        expect(compileFilterMatch([{ column: "name", op: "is_not_null" }])).toEqual({ name: { $ne: null } });
        expect(compileFilterMatch([])).toEqual({});
    });
});

describe("flattenFilters", () => {
    it("reaches conditions inside nested groups", () => {
        expect(
            flattenFilters([
                { column: "a", op: "=", value: 1 },
                {
                    combinator: "or",
                    conditions: [{ combinator: "and", conditions: [{ column: "b", op: "=", value: 2 }] }],
                },
            ])
        ).toEqual([
            { column: "a", op: "=", value: 1 },
            { column: "b", op: "=", value: 2 },
        ]);
    });
});
