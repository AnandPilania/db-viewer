import { describe, expect, it } from "vitest";
import type { ColumnDefinition } from "@pilaniaanand/driver-interface";
import { compileDraft, type DraftGroup } from "@/lib/filter-draft";

const col = (name: string, type: ColumnDefinition["type"]): ColumnDefinition => ({
    name,
    type,
    nativeType: type,
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: false,
});

const columns = [col("id", "number"), col("name", "string"), col("active", "boolean")];

const group = (combinator: "and" | "or", conditions: DraftGroup["conditions"]): DraftGroup => ({
    combinator,
    conditions,
});

describe("compileDraft", () => {
    it("sends numeric columns as numbers, not strings", () => {
        // "1000" against a bigint column compares lexically or is rejected outright.
        expect(compileDraft(group("and", [{ column: "id", op: ">", value: "1000" }]), columns)).toEqual([
            { column: "id", op: ">", value: 1000 },
        ]);
    });

    it("leaves string columns alone and splits an IN list", () => {
        expect(
            compileDraft(
                group("and", [
                    { column: "name", op: "like", value: "%ana%" },
                    { column: "id", op: "in", value: "1, 2 ,3" },
                ]),
                columns
            )
        ).toEqual([
            {
                combinator: "and",
                conditions: [
                    { column: "name", op: "like", value: "%ana%" },
                    { column: "id", op: "in", value: [1, 2, 3] },
                ],
            },
        ]);
    });

    it("omits the value for null checks and reads booleans as booleans", () => {
        expect(
            compileDraft(
                group("and", [
                    { column: "name", op: "is_null", value: "" },
                    { column: "active", op: "=", value: "true" },
                ]),
                columns
            )
        ).toEqual([
            {
                combinator: "and",
                conditions: [
                    { column: "name", op: "is_null" },
                    { column: "active", op: "=", value: true },
                ],
            },
        ]);
    });

    it("keeps a nested OR group intact", () => {
        expect(
            compileDraft(
                group("and", [
                    { column: "active", op: "=", value: "true" },
                    group("or", [
                        { column: "name", op: "=", value: "a" },
                        { column: "name", op: "=", value: "b" },
                    ]),
                ]),
                columns
            )
        ).toEqual([
            {
                combinator: "and",
                conditions: [
                    { column: "active", op: "=", value: true },
                    {
                        combinator: "or",
                        conditions: [
                            { column: "name", op: "=", value: "a" },
                            { column: "name", op: "=", value: "b" },
                        ],
                    },
                ],
            },
        ]);
    });

    it("drops half-typed conditions, and groups left empty by that drop", () => {
        expect(
            compileDraft(
                group("and", [
                    { column: "name", op: "=", value: "  " },
                    group("or", [{ column: "id", op: "=", value: "" }]),
                ]),
                columns
            )
        ).toEqual([]);
    });

    it("unwraps a group down to one surviving condition", () => {
        // `(a)` and `a` are the same predicate; emitting the group would only
        // add parentheses for the driver to compile.
        expect(
            compileDraft(
                group("and", [
                    group("or", [
                        { column: "id", op: "=", value: "7" },
                        { column: "id", op: "=", value: "" },
                    ]),
                ]),
                columns
            )
        ).toEqual([{ column: "id", op: "=", value: 7 }]);
    });
});
