import type { ColumnDefinition, FilterGroup, FilterNode, FilterOperator } from "@pilaniaanand/driver-interface";

const NULL_OPS = new Set<FilterOperator>(["is_null", "is_not_null"]);
/** Operators whose value is a comma-separated list rather than one scalar. */
const LIST_OPS = new Set<FilterOperator>(["in", "not_in", "between"]);

/**
 * The draft mirrors the FilterNode tree the driver takes, except every value
 * is the raw string the user typed — coercion to the column's type happens
 * once, on apply.
 */
export interface DraftCondition {
    column: string;
    op: FilterOperator;
    value: string;
}
export interface DraftGroup {
    combinator: "and" | "or";
    conditions: DraftNode[];
}
export type DraftNode = DraftCondition | DraftGroup;

export const isGroup = (node: DraftNode): node is DraftGroup => "combinator" in node;

export const emptyRoot = (): DraftGroup => ({ combinator: "and", conditions: [] });

/**
 * A string typed into a text input is still a string. A numeric column
 * compares it lexically ("1000" sorts before "9") or rejects it outright —
 * the same trap TableBrowser's jump-to-value box has to avoid.
 */
function coerce(raw: string, column?: ColumnDefinition): unknown {
    if (!column || (column.type !== "number" && column.type !== "boolean")) return raw;
    if (column.type === "boolean") return raw === "true" || raw === "1";
    const n = Number(raw);
    return raw.trim() !== "" && !Number.isNaN(n) ? n : raw;
}

/**
 * Drops half-typed conditions, and groups left empty by that drop, so an
 * in-progress row never reaches the database as `col = ''`. Returns [] when
 * nothing survives.
 */
export function compileDraft(node: DraftNode, columns: ColumnDefinition[]): FilterNode[] {
    if (isGroup(node)) {
        const conditions = node.conditions.flatMap((child) => compileDraft(child, columns));
        if (conditions.length === 0) return [];
        // A one-child group is just that child — no point emitting `(x)`.
        if (conditions.length === 1) return conditions;
        return [{ combinator: node.combinator, conditions } satisfies FilterGroup];
    }

    if (!node.column) return [];
    if (NULL_OPS.has(node.op)) return [{ column: node.column, op: node.op }];
    if (node.value.trim() === "") return [];

    const column = columns.find((c) => c.name === node.column);
    if (LIST_OPS.has(node.op)) {
        return [
            {
                column: node.column,
                op: node.op,
                value: node.value.split(",").map((part) => coerce(part.trim(), column)),
            },
        ];
    }
    return [{ column: node.column, op: node.op, value: coerce(node.value, column) }];
}

/** Conditions in the tree, for the count badge on the trigger button. */
export function countConditions(node: DraftNode): number {
    return isGroup(node) ? node.conditions.reduce((n, c) => n + countConditions(c), 0) : 1;
}

/**
 * Immutable edit at a path of child indexes: `editAt(root, [0, 2], fn)`
 * replaces root.conditions[0].conditions[2] with fn's result, or removes it
 * when fn returns null.
 */
export function editAt(node: DraftNode, path: number[], fn: (target: DraftNode) => DraftNode | null): DraftNode | null {
    if (path.length === 0) return fn(node);
    if (!isGroup(node)) return node;
    const [head, ...rest] = path;
    const conditions = node.conditions.flatMap((child, i) => {
        if (i !== head) return [child];
        const edited = editAt(child, rest, fn);
        return edited ? [edited] : [];
    });
    return { ...node, conditions };
}

/** NULL_OPS is also needed by the FilterBar UI (to hide the value input). */
export { NULL_OPS };
