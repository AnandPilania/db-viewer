import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnDefinition } from "@pilaniaanand/driver-interface";
import { validateValue, placeholderFor } from "@pilaniaanand/driver-interface";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GridSort {
    column: string;
    direction: "asc" | "desc";
}

interface Props {
    columns: ColumnDefinition[];
    rows: Record<string, unknown>[];
    /** First page of a new table/sort/jump — renders a skeleton rather than an empty grid. */
    initialLoading?: boolean;
    loading: boolean;
    hasMore: boolean;
    onNeedMore: () => void;
    /** Current sort, and a setter. Clicking a header cycles asc -> desc -> unsorted. */
    sort?: GridSort | null;
    onSortChange?: (sort: GridSort | null) => void;
    /**
     * Absolute row number of the first resident row, for the row-number gutter.
     * null means unknown — the user jumped to a value, and a keyset seek says
     * where a value is, not how many rows precede it.
     */
    windowStartRow?: number | null;
    /** If provided, cells become editable (double-click or Enter to edit). Returning false/rejecting keeps the cell in edit mode with the error shown. */
    onEditCell?: (rowIndex: number, column: ColumnDefinition, value: unknown) => Promise<boolean>;
    /** If provided, each row gets a delete button, and Delete/Backspace on a focused row triggers it too. */
    onDeleteRow?: (rowIndex: number) => void;
}

const ROW_HEIGHT = 32;
const FETCH_THRESHOLD_PX = 600;
const CHAR_PX = 7; // ~1ch of the grid's 12px monospace face
const MIN_COL_PX = 80;
const MAX_COL_PX = 420;
const WIDTH_SAMPLE_ROWS = 50;

/**
 * Column widths, measured once per column set from a sample of the first
 * page rather than left to the browser.
 *
 * With `table-layout: auto` (the default) plus `whitespace-nowrap`, the
 * browser re-measures every cell in the table to lay out the widest column
 * — and it redoes that whole pass each time a 200-row batch is appended.
 * Fixed layout plus explicit widths makes appending a batch cost only the
 * rows in that batch.
 */
function measureColumnWidths(columns: ColumnDefinition[], sample: Record<string, unknown>[]): number[] {
    return columns.map((col) => {
        let widest = col.name.length;
        for (const row of sample) {
            const len = formatCell(row[col.name]).length;
            if (len > widest) widest = len;
        }
        return Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, widest * CHAR_PX + 24));
    });
}

export function DataGrid({
    columns,
    rows,
    initialLoading = false,
    loading,
    hasMore,
    onNeedMore,
    sort,
    onSortChange,
    windowStartRow = 0,
    onEditCell,
    onDeleteRow,
}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [editing, setEditing] = useState<{ rowIndex: number; column: string } | null>(null);
    const [editError, setEditError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);

    // ponytail: rendered directly instead of through @tanstack/react-table. Only
    // the core row model was ever used (no sorting/filtering/pagination), and
    // rebuilding it invalidated on every render — 753 rows x N columns of work per
    // scroll frame. rows.map over the ~40 virtualized indices is the whole feature.
    const startEditing = useCallback(
        (rowIndex: number, col: ColumnDefinition | undefined) => {
            if (!col || !onEditCell || col.isPrimaryKey) return;
            setEditError(null);
            setEditing({ rowIndex, column: col.name });
        },
        [onEditCell]
    );

    // Intentionally keyed on the column set and on "has the first page landed
    // yet", NOT on rows — this must measure once and then hold still. Widths
    // that keep changing as pages arrive make the grid jump under the user.
    const hasSample = rows.length > 0;
    const columnWidths = useMemo(
        () => measureColumnWidths(columns, rows.slice(0, WIDTH_SAMPLE_ROWS)),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately not keyed on `rows`, see comment above.
        [columns, hasSample]
    );
    const gutterWidth = 64 + (onDeleteRow ? 28 : 0);
    const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0) + gutterWidth;

    const cycleSort = (column: string) => {
        if (!onSortChange) return;
        if (sort?.column !== column) onSortChange({ column, direction: "asc" });
        else if (sort.direction === "asc") onSortChange({ column, direction: "desc" });
        else onSortChange(null);
    };

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    // Read through refs so the listener is attached once per mount rather than
    // re-attached (and re-fired) on every render — re-firing it used to request
    // the next page even when the user had not scrolled at all.
    const needMoreRef = useRef(onNeedMore);
    needMoreRef.current = onNeedMore;
    const canFetchRef = useRef({ loading, hasMore });
    canFetchRef.current = { loading, hasMore };

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onScroll = () => {
            const { loading: busy, hasMore: more } = canFetchRef.current;
            if (busy || !more) return;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < FETCH_THRESHOLD_PX) needMoreRef.current();
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, []);

    // The very first page arrives shorter than the viewport, so there is nothing
    // to scroll yet — ask for the next page until the grid actually overflows.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || loading || !hasMore) return;
        if (el.scrollHeight <= el.clientHeight + FETCH_THRESHOLD_PX) onNeedMore();
    }, [loading, hasMore, rows.length, onNeedMore]);

    // Keyboard navigation: arrow keys move the focused cell (scrolling a
    // virtualized target row into view first if it isn't currently rendered),
    // Enter opens the focused cell for editing, Delete/Backspace deletes the
    // focused row. Focus is moved imperatively via data-cell lookups since
    // virtualized rows recycle their DOM nodes rather than keeping stable refs.
    function onGridKeyDown(e: React.KeyboardEvent) {
        if (!focusedCell || editing) return;
        const { row, col } = focusedCell;

        const focusCell = (targetRow: number, targetCol: number) => {
            const clampedRow = Math.max(0, Math.min(targetRow, rows.length - 1));
            const clampedCol = Math.max(0, Math.min(targetCol, columns.length - 1));
            setFocusedCell({ row: clampedRow, col: clampedCol });
            virtualizer.scrollToIndex(clampedRow, { align: "auto" });
            requestAnimationFrame(() => {
                const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${clampedRow}-${clampedCol}"]`);
                el?.focus();
                el?.scrollIntoView({ block: "nearest", inline: "nearest" });
            });
        };

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                focusCell(row + 1, col);
                break;
            case "ArrowUp":
                e.preventDefault();
                focusCell(row - 1, col);
                break;
            case "ArrowRight":
                e.preventDefault();
                focusCell(row, col + 1);
                break;
            case "ArrowLeft":
                e.preventDefault();
                focusCell(row, col - 1);
                break;
            case "Enter":
                e.preventDefault();
                startEditing(row, columns[col]);
                break;
            case "Delete":
            case "Backspace":
                if (onDeleteRow) {
                    e.preventDefault();
                    onDeleteRow(row);
                }
                break;
        }
    }

    async function commitEdit(rowIndex: number, col: ColumnDefinition, raw: string) {
        const result = validateValue(raw, col);
        if (!result.valid) {
            setEditError(result.error);
            return;
        }
        setSaving(true);
        setEditError(null);
        const ok = await onEditCell!(rowIndex, col, result.value);
        setSaving(false);
        if (ok) setEditing(null);
        else setEditError("Save failed — value not updated");
    }

    const virtualItems = virtualizer.getVirtualItems();
    const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
    const paddingBottom =
        virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;
    const colSpan = columns.length + 1; // + the row-number gutter

    if (initialLoading && rows.length === 0) return <GridSkeleton columnCount={Math.max(columns.length, 5)} />;

    if (!initialLoading && !loading && rows.length === 0) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                No rows to show.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div
                ref={scrollRef}
                className="flex-1 overflow-auto"
                onKeyDown={onGridKeyDown}
                tabIndex={focusedCell ? undefined : 0}
                aria-label={focusedCell ? undefined : "Data grid — press Enter or an arrow key to start navigating"}
                onFocus={(e) => {
                    if (!focusedCell && rows.length > 0 && e.target === e.currentTarget) {
                        setFocusedCell({ row: 0, col: 0 });
                        requestAnimationFrame(() => {
                            scrollRef.current?.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
                        });
                    }
                }}
            >
                <table
                    role="grid"
                    aria-rowcount={rows.length}
                    className="border-collapse text-sm"
                    style={{ tableLayout: "fixed", width: totalWidth, minWidth: "100%" }}
                >
                    <thead className="sticky top-0 z-10 bg-card">
                        <tr>
                            <th
                                style={{ width: gutterWidth }}
                                scope="col"
                                className="border-b border-r border-border bg-card px-2 py-1.5 text-right text-[10px] font-normal text-muted-foreground/70"
                            >
                                #
                            </th>
                            {columns.map((col, colIndex) => {
                                const sorted = sort?.column === col.name ? sort.direction : null;
                                return (
                                    <th
                                        key={col.name}
                                        scope="col"
                                        style={{ width: columnWidths[colIndex] }}
                                        aria-sort={
                                            sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                                        }
                                        className="border-b border-r border-border p-0 text-left text-xs font-medium text-muted-foreground"
                                    >
                                        <button
                                            type="button"
                                            disabled={!onSortChange}
                                            onClick={() => cycleSort(col.name)}
                                            title={`${col.name} — ${col.nativeType ?? col.type}${onSortChange ? " (click to sort)" : ""}`}
                                            className={cn(
                                                "flex w-full items-center gap-1 px-3 py-1.5 text-left",
                                                onSortChange && "hover:bg-muted/60",
                                                sorted && "text-foreground"
                                            )}
                                        >
                                            <span className="truncate">{col.name}</span>
                                            {sorted === "asc" && <ArrowUp size={10} className="shrink-0" />}
                                            {sorted === "desc" && <ArrowDown size={10} className="shrink-0" />}
                                            {col.isPrimaryKey && (
                                                <span className="shrink-0 text-[9px] text-accent">PK</span>
                                            )}
                                        </button>
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {paddingTop > 0 && (
                            <tr>
                                <td style={{ height: paddingTop }} colSpan={colSpan} />
                            </tr>
                        )}
                        {virtualItems.map((vi) => {
                            const row = rows[vi.index];
                            if (!row) return null;
                            return (
                                <tr
                                    key={vi.key}
                                    className={cn("hover:bg-muted/40", vi.index % 2 === 1 && "bg-card/40")}
                                    style={{ height: ROW_HEIGHT }}
                                >
                                    <td
                                        style={{ width: gutterWidth }}
                                        className="border-r border-border/60 px-2 text-right align-middle font-mono text-[10px] text-muted-foreground/70"
                                    >
                                        <span className="inline-flex w-full items-center justify-end gap-1.5">
                                            {windowStartRow === null
                                                ? "·"
                                                : (windowStartRow + vi.index + 1).toLocaleString()}
                                            {onDeleteRow && (
                                                <button
                                                    onClick={() => onDeleteRow(vi.index)}
                                                    className="text-muted-foreground hover:text-destructive"
                                                    aria-label={`Delete row ${vi.index + 1}`}
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </span>
                                    </td>
                                    {columns.map((col, colIndex) => {
                                        const isEditing = editing?.rowIndex === vi.index && editing.column === col.name;
                                        const isFocused =
                                            focusedCell?.row === vi.index && focusedCell?.col === colIndex;
                                        return (
                                            <td
                                                key={col.name}
                                                style={{ width: columnWidths[colIndex] }}
                                                className="overflow-hidden border-r border-border/60 px-3 py-1 font-mono text-xs text-foreground/90"
                                            >
                                                {isEditing ? (
                                                    <EditCell
                                                        column={col}
                                                        initial={row[col.name]}
                                                        error={editError}
                                                        saving={saving}
                                                        onCancel={() => {
                                                            setEditing(null);
                                                            setEditError(null);
                                                        }}
                                                        onCommit={(value) => commitEdit(vi.index, col, value)}
                                                    />
                                                ) : (
                                                    <div
                                                        role="gridcell"
                                                        data-cell={`${vi.index}-${colIndex}`}
                                                        tabIndex={isFocused ? 0 : -1}
                                                        aria-readonly={!onEditCell || col.isPrimaryKey}
                                                        className={cn(
                                                            "truncate outline-none",
                                                            onEditCell &&
                                                                !col.isPrimaryKey &&
                                                                "cursor-text hover:bg-accent/10",
                                                            isFocused && "ring-1 ring-inset ring-accent"
                                                        )}
                                                        onFocus={() => setFocusedCell({ row: vi.index, col: colIndex })}
                                                        onClick={() => setFocusedCell({ row: vi.index, col: colIndex })}
                                                        onDoubleClick={() => startEditing(vi.index, col)}
                                                    >
                                                        {formatCell(row[col.name])}
                                                    </div>
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                        {paddingBottom > 0 && (
                            <tr>
                                <td style={{ height: paddingBottom }} colSpan={colSpan} />
                            </tr>
                        )}
                    </tbody>
                </table>
                {loading && (
                    // sticky, not static — more rows are fetched proactively (see
                    // FETCH_THRESHOLD_PX) while the user is still short of the actual
                    // bottom of the table, so a normal in-flow indicator would render
                    // off-screen below their current scroll position every time.
                    <div
                        role="status"
                        className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground"
                    >
                        <span className="size-2 animate-pulse rounded-full bg-accent" aria-hidden />
                        Loading more rows…
                    </div>
                )}
                {!loading && !hasMore && rows.length > 0 && (
                    <div className="sticky bottom-0 border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                        End of table.
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Owns its own draft state so typing re-renders one cell rather than the
 * whole grid (which is what made editing feel laggy alongside the row-model
 * rebuild). Keyed by the editing cell, so switching cells resets the draft.
 */
function EditCell({
    column,
    initial,
    error,
    saving,
    onCommit,
    onCancel,
}: {
    column: ColumnDefinition;
    initial: unknown;
    error: string | null;
    saving: boolean;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(initial === null || initial === undefined ? "" : String(initial));
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);

    return (
        <div className="relative">
            <input
                ref={ref}
                value={draft}
                disabled={saving}
                aria-label={`Edit ${column.name}`}
                aria-invalid={!!error}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    e.stopPropagation(); // don't let the grid's own arrow-key navigation intercept typing
                    if (e.key === "Enter") onCommit(draft);
                    if (e.key === "Escape") onCancel();
                }}
                onBlur={() => onCommit(draft)}
                placeholder={placeholderFor(column)}
                className={cn(
                    "w-full rounded border bg-background px-1 py-0.5 font-mono text-xs outline-none",
                    error ? "border-destructive" : "border-accent"
                )}
            />
            {error && (
                <div
                    role="alert"
                    className="absolute left-0 top-full z-20 mt-0.5 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[10px] text-destructive-foreground shadow"
                >
                    {error}
                </div>
            )}
        </div>
    );
}

/**
 * Shown instead of an empty grid while the first page is in flight. The old
 * behaviour was a blank pane that suddenly popped into a full table, which
 * read as a hang on a slow connection.
 */
function GridSkeleton({ columnCount }: { columnCount: number }) {
    return (
        <div role="status" aria-label="Loading rows" className="flex h-full flex-col overflow-hidden">
            <div className="flex gap-3 border-b border-border bg-card px-3 py-2">
                {Array.from({ length: columnCount }).map((_, i) => (
                    <div key={i} className="h-3 flex-1 animate-pulse rounded bg-muted" />
                ))}
            </div>
            {Array.from({ length: 14 }).map((_, row) => (
                <div key={row} className="flex gap-3 border-b border-border/40 px-3 py-2">
                    {Array.from({ length: columnCount }).map((_, col) => (
                        <div
                            key={col}
                            className="h-3 flex-1 animate-pulse rounded bg-muted/60"
                            // Staggered so it reads as a loading sweep rather than one flashing block.
                            style={{ animationDelay: `${(row * columnCount + col) * 18}ms` }}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}
