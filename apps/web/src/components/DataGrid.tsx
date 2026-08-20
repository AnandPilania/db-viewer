import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ColumnDefinition } from "@db-viewer/driver-interface";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { validateValue, placeholderFor } from "@/lib/validation";

interface Props {
  columns: ColumnDefinition[];
  rows: Record<string, unknown>[];
  loading: boolean;
  hasMore: boolean;
  onNeedMore: () => void;
  /** If provided, cells become editable (double-click or Enter to edit). Returning false/rejecting keeps the cell in edit mode with the error shown. */
  onEditCell?: (rowIndex: number, column: ColumnDefinition, value: unknown) => Promise<boolean>;
  /** If provided, each row gets a delete button, and Delete/Backspace on a focused row triggers it too. */
  onDeleteRow?: (rowIndex: number) => void;
}

const ROW_HEIGHT = 32;
const FETCH_THRESHOLD_PX = 600;

export function DataGrid({ columns, rows, loading, hasMore, onNeedMore, onEditCell, onDeleteRow }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ rowIndex: number; column: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);

  function startEditing(rowIndex: number, col: ColumnDefinition) {
    if (!onEditCell || col.isPrimaryKey) return;
    const raw = rows[rowIndex]?.[col.name];
    setDraft(raw === null || raw === undefined ? "" : String(raw));
    setEditError(null);
    setEditing({ rowIndex, column: col.name });
  }

  const tableColumns: ColumnDef<Record<string, unknown>>[] = columns.map((col, colIndex) => ({
    accessorKey: col.name,
    header: col.name,
    cell: (info) => {
      const rowIndex = info.row.index;
      const isEditing = editing?.rowIndex === rowIndex && editing.column === col.name;
      const isFocused = focusedCell?.row === rowIndex && focusedCell?.col === colIndex;

      if (isEditing) {
        return (
          <EditCell
            column={col}
            draft={draft}
            setDraft={setDraft}
            error={editError}
            saving={saving}
            onCancel={() => {
              setEditing(null);
              setEditError(null);
            }}
            onCommit={async () => {
              const result = validateValue(draft, col);
              if (!result.valid) {
                setEditError(result.error);
                return;
              }
              setSaving(true);
              setEditError(null);
              const ok = await onEditCell!(rowIndex, col, result.value);
              setSaving(false);
              if (ok) {
                setEditing(null);
              } else {
                setEditError("Save failed — value not updated");
              }
            }}
          />
        );
      }

      return (
        <div
          role="gridcell"
          data-cell={`${rowIndex}-${colIndex}`}
          tabIndex={isFocused ? 0 : -1}
          aria-readonly={!onEditCell || col.isPrimaryKey}
          className={cn(
            "truncate outline-none",
            onEditCell && !col.isPrimaryKey && "cursor-text hover:bg-accent/10",
            isFocused && "ring-1 ring-inset ring-accent"
          )}
          onFocus={() => setFocusedCell({ row: rowIndex, col: colIndex })}
          onClick={() => setFocusedCell({ row: rowIndex, col: colIndex })}
          onDoubleClick={() => startEditing(rowIndex, col)}
        >
          {formatCell(info.getValue())}
        </div>
      );
    },
  }));

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (loading || !hasMore) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < FETCH_THRESHOLD_PX) onNeedMore();
    };
    el.addEventListener("scroll", onScroll);
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [loading, hasMore, onNeedMore, tableRows.length]);

  // Keyboard navigation: arrow keys move the focused cell (scrolling a
  // virtualized target row into view first if it isn't currently rendered),
  // Enter opens the focused cell for editing, Delete/Backspace deletes the
  // focused row. Focus is moved imperatively via data-cell lookups since
  // virtualized rows recycle their DOM nodes rather than keeping stable refs.
  function onGridKeyDown(e: React.KeyboardEvent) {
    if (!focusedCell || editing) return;
    const { row, col } = focusedCell;
    const colCount = columns.length;
    const rowCount = rows.length;

    const focusCell = (targetRow: number, targetCol: number) => {
      const clampedRow = Math.max(0, Math.min(targetRow, rowCount - 1));
      const clampedCol = Math.max(0, Math.min(targetCol, colCount - 1));
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

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

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
        <table role="grid" aria-rowcount={rows.length} className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {onDeleteRow && (
                  <th className="w-8 border-b border-r border-border bg-card px-1 py-1.5" aria-hidden />
                )}
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="whitespace-nowrap border-b border-r border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td style={{ height: paddingTop }} colSpan={columns.length + (onDeleteRow ? 1 : 0)} />
              </tr>
            )}
            {virtualItems.map((vi) => {
              const row = tableRows[vi.index];
              return (
                <tr
                  key={row.id}
                  className={cn("hover:bg-muted/40", vi.index % 2 === 1 && "bg-card/40")}
                  style={{ height: ROW_HEIGHT }}
                >
                  {onDeleteRow && (
                    <td className="border-r border-border/60 px-1 text-center">
                      <button
                        onClick={() => onDeleteRow(vi.index)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Delete row ${vi.index + 1}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  )}
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="whitespace-nowrap border-r border-border/60 px-3 py-1 font-mono text-xs text-foreground/90"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: paddingBottom }} colSpan={columns.length + (onDeleteRow ? 1 : 0)} />
              </tr>
            )}
          </tbody>
        </table>
        {loading && (
          <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Loading more rows…
          </div>
        )}
        {!hasMore && rows.length > 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">End of table — {rows.length.toLocaleString()} rows loaded.</div>
        )}
      </div>
    </div>
  );
}

function EditCell({
  column,
  draft,
  setDraft,
  error,
  saving,
  onCommit,
  onCancel,
}: {
  column: ColumnDefinition;
  draft: string;
  setDraft: (v: string) => void;
  error: string | null;
  saving: boolean;
  onCommit: () => void;
  onCancel: () => void;
}) {
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
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCommit}
        placeholder={placeholderFor(column)}
        className={cn(
          "w-full rounded border bg-background px-1 py-0.5 font-mono text-xs outline-none",
          error ? "border-destructive" : "border-accent"
        )}
      />
      {error && (
        <div role="alert" className="absolute left-0 top-full z-20 mt-0.5 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[10px] text-destructive-foreground shadow">
          {error}
        </div>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
