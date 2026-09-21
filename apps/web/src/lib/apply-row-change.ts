import type { RowChangeEvent } from "@/hooks/useTableRealtime";

/**
 * Applies one realtime change event to a list of rows.
 *
 * Idempotent by design: rows are matched by primary key, not by array
 * position, so applying an event the client already applied optimistically is
 * a no-op rather than a double-edit. That matters because the server echoes
 * back every change made through this app, including the client's own — there
 * is no per-client filtering on the channel.
 *
 * Returns the same array reference when nothing changed, so React can skip
 * the re-render.
 *
 * Pure and separate from the hook so it can be tested without a renderer —
 * the correctness of this function is the difference between a live grid and a
 * quietly wrong one.
 */
export function applyRowChange(
    rows: Record<string, unknown>[],
    event: RowChangeEvent,
    pkColumns: string[]
): Record<string, unknown>[] {
    // Without a known primary key there is no safe way to identify the affected
    // row, and guessing would corrupt the view. Refetching is the caller's job.
    if (pkColumns.length === 0) return rows;

    // Compared as strings: a bigint arrives as a string over JSON while the
    // loaded row may hold a number, and a Date/ObjectId round-trips as a string
    // too. Lenient here beats a live grid that silently stops matching.
    const matches = (row: Record<string, unknown>, pk: Record<string, unknown>) =>
        pkColumns.every((c) => c in pk && String(row[c]) === String(pk[c]));

    if (event.type === "insert" && event.row) {
        if (rows.some((r) => matches(r, event.row!))) return rows;
        return [event.row, ...rows];
    }

    if (event.type === "update" && event.primaryKey) {
        const target = event.primaryKey;
        // MongoDB's change-stream path sends whole-document replacements
        // (column "__row__") rather than a single field patch.
        if (event.column === "__row__" && event.value && typeof event.value === "object") {
            const replacement = event.value as Record<string, unknown>;
            let hit = false;
            const next = rows.map((r) => {
                if (!matches(r, target)) return r;
                hit = true;
                return replacement;
            });
            return hit ? next : rows;
        }
        if (event.column) {
            const column = event.column;
            let hit = false;
            const next = rows.map((r) => {
                if (!matches(r, target) || r[column] === event.value) return r;
                hit = true;
                return { ...r, [column]: event.value };
            });
            return hit ? next : rows;
        }
        return rows;
    }

    if (event.type === "delete" && event.primaryKey) {
        const target = event.primaryKey;
        const next = rows.filter((r) => !matches(r, target));
        return next.length === rows.length ? rows : next;
    }

    return rows;
}
