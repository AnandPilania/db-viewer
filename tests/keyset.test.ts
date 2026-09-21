import { describe, expect, it } from "vitest";
import { keysetComparison, resolveOrderBy } from "@pilaniaanand/driver-interface";

const pg = {
    quote: (id: string) => `"${id}"`,
    placeholder: (i: number) => `$${i + 1}`,
};

/**
 * Keyset pagination is the one piece of logic here that fails *silently*: a
 * wrong operator or a missing tiebreaker doesn't throw, it just skips or
 * repeats rows somewhere in the middle of a table nobody is looking at.
 */
describe("resolveOrderBy", () => {
    it("appends the primary key as a tiebreaker", () => {
        expect(resolveOrderBy([{ column: "created_at", direction: "asc" }], ["id"])).toEqual([
            { column: "created_at", direction: "asc" },
            { column: "id", direction: "asc" },
        ]);
    });

    it("orders by primary key alone when no sort is requested", () => {
        expect(resolveOrderBy(undefined, ["tenant_id", "id"])).toEqual([
            { column: "tenant_id", direction: "asc" },
            { column: "id", direction: "asc" },
        ]);
    });

    it("does not repeat a primary-key column already named in the sort", () => {
        const plan = resolveOrderBy([{ column: "id", direction: "desc" }], ["id"]);
        expect(plan).toEqual([{ column: "id", direction: "desc" }]);
    });

    it("gives the tiebreaker the sort's direction, so the tuple sorts uniformly", () => {
        // A mixed-direction tuple would make the single row-wise comparison in
        // keysetComparison wrong — every column must agree.
        const plan = resolveOrderBy([{ column: "score", direction: "desc" }], ["id"]);
        expect(plan.map((p) => p.direction)).toEqual(["desc", "desc"]);
    });

    it("takes the direction of the first sort entry for all columns", () => {
        const plan = resolveOrderBy(
            [
                { column: "a", direction: "desc" },
                { column: "b", direction: "asc" },
            ],
            ["id"]
        );
        expect(plan.map((p) => p.direction)).toEqual(["desc", "desc", "desc"]);
    });

    it("deduplicates repeated sort columns", () => {
        const plan = resolveOrderBy(
            [
                { column: "a", direction: "asc" },
                { column: "a", direction: "asc" },
            ],
            ["id"]
        );
        expect(plan.map((p) => p.column)).toEqual(["a", "id"]);
    });
});

describe("keysetComparison", () => {
    it("uses a bare comparison for a single ordering column", () => {
        expect(keysetComparison(["id"], 1, { descending: false, inclusive: false, ...pg })).toBe('"id" > $1');
    });

    it("uses a row-wise tuple for a compound key", () => {
        expect(keysetComparison(["created_at", "id"], 2, { descending: false, inclusive: false, ...pg })).toBe(
            '("created_at", "id") > ($1, $2)'
        );
    });

    it("flips the operator when descending", () => {
        expect(keysetComparison(["id"], 1, { descending: true, inclusive: false, ...pg })).toBe('"id" < $1');
    });

    it("is inclusive for a seek and exclusive for a cursor", () => {
        // A cursor continues after a row already shown; a seek must include the
        // row it lands on, or jumping to a value skips that value's first row.
        expect(keysetComparison(["id"], 1, { descending: false, inclusive: true, ...pg })).toBe('"id" >= $1');
        expect(keysetComparison(["id"], 1, { descending: true, inclusive: true, ...pg })).toBe('"id" <= $1');
    });

    it("supports a prefix seek naming fewer values than ordering columns", () => {
        expect(keysetComparison(["created_at", "id"], 1, { descending: false, inclusive: true, ...pg })).toBe(
            '"created_at" >= $1'
        );
    });

    it("offsets placeholders so a predicate can follow earlier bound params", () => {
        const sql = keysetComparison(["a", "b"], 2, {
            descending: false,
            inclusive: false,
            quote: pg.quote,
            placeholder: (i) => `$${i + 5}`,
        });
        expect(sql).toBe('("a", "b") > ($5, $6)');
    });

    it("renders MySQL-style backticks and positional placeholders", () => {
        const sql = keysetComparison(["id"], 1, {
            descending: false,
            inclusive: false,
            quote: (id) => `\`${id}\``,
            placeholder: () => "?",
        });
        expect(sql).toBe("`id` > ?");
    });

    it("rejects more values than ordering columns rather than building a bad tuple", () => {
        expect(() => keysetComparison(["id"], 2, { descending: false, inclusive: false, ...pg })).toThrow();
    });

    it("rejects an empty value list", () => {
        expect(() => keysetComparison(["id"], 0, { descending: false, inclusive: false, ...pg })).toThrow();
    });
});
