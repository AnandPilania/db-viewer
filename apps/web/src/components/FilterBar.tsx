import { useState } from "react";
import { Filter, Plus, X } from "lucide-react";
import {
    flattenFilters,
    isFilterGroup,
    type ColumnDefinition,
    type FilterNode,
    type FilterOperator,
} from "@pilaniaanand/driver-interface";
import { Button } from "@/components/ui/button";
import {
    compileDraft,
    countConditions,
    draftFromApplied,
    editAt,
    emptyRoot,
    isGroup,
    NULL_OPS,
    type DraftCondition,
    type DraftGroup,
    type DraftNode,
} from "@/lib/filter-draft";

/** Mirrors FilterOperator — the shared compiler rejects anything outside this set. */
const OPS: { op: FilterOperator; label: string }[] = [
    { op: "=", label: "=" },
    { op: "!=", label: "≠" },
    { op: ">", label: ">" },
    { op: ">=", label: "≥" },
    { op: "<", label: "<" },
    { op: "<=", label: "≤" },
    { op: "between", label: "between" },
    { op: "contains", label: "contains" },
    { op: "not_contains", label: "doesn't contain" },
    { op: "starts_with", label: "starts with" },
    { op: "ends_with", label: "ends with" },
    { op: "like", label: "like (pattern)" },
    { op: "not_like", label: "not like" },
    { op: "in", label: "in" },
    { op: "not_in", label: "not in" },
    { op: "is_null", label: "is null" },
    { op: "is_not_null", label: "not null" },
];

const PLACEHOLDERS: Partial<Record<FilterOperator, string>> = {
    in: "a, b, c",
    not_in: "a, b, c",
    between: "low, high",
    like: "%term%",
    not_like: "%term%",
};

interface Props {
    columns: ColumnDefinition[];
    /** Currently applied tree. The draft resets when this is emptied (e.g. on table switch). */
    applied: FilterNode[];
    onApply: (filters: FilterNode[]) => void;
}

export function FilterBar({ columns, applied, onApply }: Props) {
    const [open, setOpen] = useState(false);
    // Lazy initializer: a fresh mount (e.g. drill-to-detail navigating to the
    // Data tab) can already have a non-empty `applied` on the very first
    // render, before the prevApplied-diffing below ever runs — so the draft
    // has to start from `applied`, not unconditionally empty.
    const [root, setRoot] = useState<DraftGroup>(() =>
        applied.length === 0 ? emptyRoot() : draftFromApplied(applied)
    );

    // The parent clears filters when the table changes (the draft names columns
    // of that old table, so it goes with them) and pre-applies one when landing
    // from drill-to-detail — either way the draft needs to mirror `applied`
    // rather than keep showing whatever was last open. Adjusted during render
    // (React's documented pattern for resetting state on a prop change) rather
    // than in an effect, so there's no extra frame showing the stale draft.
    const [prevApplied, setPrevApplied] = useState(applied);
    if (prevApplied !== applied) {
        setPrevApplied(applied);
        setRoot(applied.length === 0 ? emptyRoot() : draftFromApplied(applied));
    }

    function edit(path: number[], fn: (target: DraftNode) => DraftNode | null) {
        setRoot((prev) => (editAt(prev, path, fn) as DraftGroup | null) ?? emptyRoot());
    }

    function addTo(path: number[], child: DraftNode) {
        edit(path, (target) => (isGroup(target) ? { ...target, conditions: [...target.conditions, child] } : target));
    }

    const newCondition = (): DraftCondition => ({ column: columns[0]?.name ?? "", op: "=", value: "" });
    const newGroup = (): DraftGroup => ({ combinator: "or", conditions: [newCondition()] });

    function apply() {
        onApply(compileDraft(root, columns));
        setOpen(false);
    }

    function clear() {
        setRoot(emptyRoot());
        onApply([]);
    }

    const activeCount = applied.length > 0 ? countConditions(root) : 0;

    // Plain-text readout of what's applied, e.g. `status = "Done"` — visible
    // without opening the editor, so a drill-to-detail landing (or any other
    // pre-applied filter) shows *why* these are the rows on screen.
    const summary = flattenFilters(applied)
        .map((c) => {
            const opLabel = OPS.find((o) => o.op === c.op)?.label ?? c.op;
            if (NULL_OPS.has(c.op)) return `${c.column} ${opLabel}`;
            return `${c.column} ${opLabel} ${JSON.stringify(c.value)}`;
        })
        .join(applied.some(isFilterGroup) ? " / " : " and ");

    function renderCondition(node: DraftCondition, path: number[]) {
        return (
            <div className="flex items-center gap-1.5">
                <select
                    aria-label="Filter column"
                    value={node.column}
                    onChange={(e) => edit(path, (t) => ({ ...(t as DraftCondition), column: e.target.value }))}
                    className="h-7 w-40 shrink-0 rounded border border-border bg-background px-1.5 text-xs outline-none focus:border-accent"
                >
                    {columns.map((c) => (
                        <option key={c.name} value={c.name}>
                            {c.name}
                        </option>
                    ))}
                </select>

                <select
                    aria-label="Filter operator"
                    value={node.op}
                    onChange={(e) =>
                        edit(path, (t) => ({ ...(t as DraftCondition), op: e.target.value as FilterOperator }))
                    }
                    className="h-7 w-32 shrink-0 rounded border border-border bg-background px-1.5 text-xs outline-none focus:border-accent"
                >
                    {OPS.map((o) => (
                        <option key={o.op} value={o.op}>
                            {o.label}
                        </option>
                    ))}
                </select>

                {NULL_OPS.has(node.op) ? (
                    <span className="h-7 flex-1" aria-hidden />
                ) : (
                    <input
                        aria-label="Filter value"
                        value={node.value}
                        onChange={(e) => edit(path, (t) => ({ ...(t as DraftCondition), value: e.target.value }))}
                        placeholder={PLACEHOLDERS[node.op] ?? "value"}
                        className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs outline-none focus:border-accent"
                    />
                )}

                <button
                    type="button"
                    onClick={() => edit(path, () => null)}
                    aria-label={`Remove condition on ${node.column}`}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <X size={12} />
                </button>
            </div>
        );
    }

    function renderGroup(group: DraftGroup, path: number[]) {
        const nested = path.length > 0;
        return (
            <div className={nested ? "rounded border border-border bg-background/40 p-2" : ""}>
                <div className="mb-1.5 flex items-center gap-2">
                    {/* One combinator per group rather than a joiner between every pair:
              mixing AND and OR at the same level has no defined meaning, and
              the extra nesting is what the Group button is for. */}
                    <div className="inline-flex overflow-hidden rounded border border-border">
                        {(["and", "or"] as const).map((c) => (
                            <button
                                key={c}
                                type="button"
                                aria-pressed={group.combinator === c}
                                onClick={() => edit(path, (t) => ({ ...(t as DraftGroup), combinator: c }))}
                                className={`px-2 py-0.5 text-[11px] uppercase ${
                                    group.combinator === c
                                        ? "bg-accent text-accent-foreground"
                                        : "text-muted-foreground hover:bg-muted"
                                }`}
                            >
                                {c}
                            </button>
                        ))}
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                        {group.combinator === "and" ? "match all of these" : "match any of these"}
                    </span>
                    {nested && (
                        <button
                            type="button"
                            onClick={() => edit(path, () => null)}
                            aria-label="Remove group"
                            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                            <X size={12} />
                        </button>
                    )}
                </div>

                <div className="flex flex-col gap-1.5 border-l border-border pl-2">
                    {group.conditions.map((child, i) => (
                        <div key={i}>
                            {isGroup(child) ? renderGroup(child, [...path, i]) : renderCondition(child, [...path, i])}
                        </div>
                    ))}
                    <div className="flex items-center gap-1">
                        <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => addTo(path, newCondition())}
                            disabled={columns.length === 0}
                        >
                            <Plus size={12} /> Condition
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => addTo(path, newGroup())}
                            disabled={columns.length === 0}
                        >
                            <Plus size={12} /> Group
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="relative border-b border-border px-3 py-1.5"
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant={activeCount > 0 ? "secondary" : "ghost"}
                    onClick={() => setOpen((o) => !o)}
                    aria-expanded={open}
                >
                    <Filter size={12} /> Filter
                    {activeCount > 0 && (
                        <span className="rounded bg-accent px-1 text-[10px] text-accent-foreground">{activeCount}</span>
                    )}
                </Button>
                {activeCount > 0 && (
                    <Button size="sm" variant="ghost" onClick={clear}>
                        Clear
                    </Button>
                )}
                {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
            </div>

            {open && (
                <div className="absolute left-3 top-full z-20 mt-1 w-[34rem] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card p-3 shadow-lg">
                    <div className="max-h-[50vh] overflow-y-auto">{renderGroup(root, [])}</div>
                    <div className="mt-2 flex items-center justify-end gap-2 border-t border-border pt-2">
                        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={apply}>
                            Apply
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
