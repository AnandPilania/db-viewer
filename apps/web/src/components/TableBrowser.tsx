import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash, Download, Plus, Radio, CornerUpLeft, Search } from "lucide-react";
import type { ColumnDefinition } from "@pilaniaanand/driver-interface";
import { api } from "@/lib/api";
import { useTableRows } from "@/hooks/useTableRows";
import { useTableRealtime } from "@/hooks/useTableRealtime";
import { DataGrid } from "@/components/DataGrid";
import { NewRowDialog } from "@/components/NewRowDialog";
import { Button } from "@/components/ui/button";

interface Props {
  connectionId: string;
  table: string;
}

export function TableBrowser({ connectionId, table }: Props) {
  const {
    rows,
    columns,
    orderBy,
    sort,
    changeSort,
    initialLoading,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMore,
    jumpTo,
    jumpToStart,
    anchorLabel,
    windowStartRow,
    windowCapped,
    updateLocalCell,
    prependRow,
    removeLocalRowAt,
    applyChangeEvent,
  } = useTableRows(connectionId, table);
  const [wantExact, setWantExact] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [showNewRow, setShowNewRow] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  // Live updates: any insert/update/delete made through this app (any tab,
  // any user) — plus external writes too, for drivers that support native
  // change notification (currently MongoDB via Change Streams).
  useTableRealtime(connectionId, table, applyChangeEvent);

  const { data: estimate } = useQuery({
    queryKey: ["count-estimate", connectionId, table],
    queryFn: () => api.estimateCount(connectionId, table),
  });

  const { data: exact, isFetching: exactLoading } = useQuery({
    queryKey: ["count-exact", connectionId, table],
    queryFn: () => api.countExact(connectionId, table),
    enabled: wantExact,
  });

  /**
   * A driver reports `orderBy` only if it actually honours sort and seek —
   * MongoDB and Redis don't. Sorting and jump-to-value are hidden for those
   * rather than shown as controls that quietly do nothing.
   */
  const seekColumn = orderBy[0]?.column ?? null;
  const sortable = orderBy.length > 0;

  function startExport(format: "csv" | "ndjson") {
    setExportOpen(false);
    window.location.href = `/api/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(table)}/export?format=${format}`;
  }

  function submitJump(e: React.FormEvent) {
    e.preventDefault();
    const raw = jumpValue.trim();
    if (!raw) return;
    const column = columns.find((c) => c.name === seekColumn);
    // Numeric keys must be sent as numbers — a string "1000" compares
    // lexically against a bigint column and the database rejects or
    // mis-orders it.
    const numeric = column && (column.type === "number" || column.type === "boolean");
    jumpTo(numeric && raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
  }

  async function handleEditCell(rowIndex: number, column: ColumnDefinition, value: unknown): Promise<boolean> {
    const row = rows[rowIndex];
    const primaryKey = Object.fromEntries(
      columns.filter((c) => c.isPrimaryKey).map((c) => [c.name, row[c.name]])
    );
    if (Object.keys(primaryKey).length === 0) {
      setActionError("This table has no primary key, so a single cell can't be updated safely.");
      return false;
    }

    const previous = row[column.name];
    setActionError(null);
    updateLocalCell(rowIndex, column.name, value); // optimistic
    try {
      await api.updateCell(connectionId, table, { primaryKey, column: column.name, value });
      return true;
    } catch (err) {
      updateLocalCell(rowIndex, column.name, previous); // rollback
      // Surface the database's actual complaint (constraint violation, type
      // error, permission) instead of swallowing it behind a generic message.
      setActionError((err as Error).message);
      return false;
    }
  }

  async function handleCreateRow(values: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const inserted = await api.insertRow(connectionId, table, { values });
      prependRow(inserted);
      setShowNewRow(false);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function handleDeleteRow(rowIndex: number) {
    const row = rows[rowIndex];
    const primaryKey = Object.fromEntries(
      columns.filter((c) => c.isPrimaryKey).map((c) => [c.name, row[c.name]])
    );
    if (Object.keys(primaryKey).length === 0) return;
    if (!window.confirm("Delete this row? This can't be undone.")) return;

    setActionError(null);
    removeLocalRowAt(rowIndex); // optimistic
    try {
      await api.deleteRow(connectionId, table, { primaryKey });
    } catch (err) {
      prependRow(row); // rollback — simplest safe recovery, re-adds at top rather than exact position
      setActionError(`Delete failed: ${(err as Error).message}`);
    }
  }

  const rowCount = exact?.value ?? estimate?.value ?? null;
  const shownFrom = windowStartRow === null ? null : windowStartRow + 1;
  const shownTo = windowStartRow === null ? null : windowStartRow + rows.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{table}</span>
          <span title="Live updates active" className="shrink-0 text-accent">
            <Radio size={11} />
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {/* Jump-to-value: how a windowed grid reaches a position deep in a
              huge table without paging through everything before it. */}
          {seekColumn && (
            <form onSubmit={submitJump} className="flex items-center gap-1">
              <label className="sr-only" htmlFor="jump-value">
                Jump to {seekColumn}
              </label>
              <div className="relative">
                <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="jump-value"
                  value={jumpValue}
                  onChange={(e) => setJumpValue(e.target.value)}
                  placeholder={`Jump to ${seekColumn}…`}
                  className="w-36 rounded border border-border bg-background py-1 pl-6 pr-1.5 text-xs outline-none focus:border-accent"
                />
              </div>
              {anchorLabel !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  title="Back to the start of the table"
                  onClick={() => {
                    setJumpValue("");
                    jumpToStart();
                  }}
                >
                  <CornerUpLeft size={12} /> Top
                </Button>
              )}
            </form>
          )}

          <span className="flex items-center gap-1 whitespace-nowrap">
            <Hash size={12} />
            {shownFrom !== null && rows.length > 0 ? (
              <>
                {shownFrom.toLocaleString()}–{shownTo!.toLocaleString()}
                {rowCount !== null && (
                  <>
                    {" of "}
                    {exact ? rowCount.toLocaleString() : `~${rowCount.toLocaleString()}`}
                  </>
                )}
              </>
            ) : rowCount !== null ? (
              <>
                {exact ? rowCount.toLocaleString() : `~${rowCount.toLocaleString()}`} rows
                {anchorLabel !== null && ` · at ${anchorLabel}`}
              </>
            ) : (
              <span>counting…</span>
            )}
          </span>

          {!wantExact && (
            <Button size="sm" variant="ghost" onClick={() => setWantExact(true)} disabled={exactLoading}>
              {exactLoading ? "Counting…" : "Get exact count"}
            </Button>
          )}

          <Button size="sm" variant="secondary" onClick={() => setShowNewRow(true)}>
            <Plus size={12} /> New row
          </Button>

          <div className="relative" onKeyDown={(e) => e.key === "Escape" && setExportOpen(false)}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setExportOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
            >
              <Download size={12} /> Export
            </Button>
            {exportOpen && (
              <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-32 rounded-md border border-border bg-card shadow-lg">
                <button
                  role="menuitem"
                  onClick={() => startExport("csv")}
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/60"
                >
                  CSV
                </button>
                <button
                  role="menuitem"
                  onClick={() => startExport("ndjson")}
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/60"
                >
                  NDJSON
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {actionError && (
        <div role="alert" className="flex items-start justify-between gap-3 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 underline" aria-label="Dismiss error">
            Dismiss
          </button>
        </div>
      )}
      {windowCapped && (
        <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing a moving window of the most recent {rows.length.toLocaleString()} rows scrolled through. Earlier rows
          are reloaded on scroll up{seekColumn ? `, or jump straight to a ${seekColumn} value` : ""}.
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <DataGrid
          columns={columns}
          rows={rows}
          initialLoading={initialLoading}
          loading={loadingMore || (loading && rows.length === 0)}
          hasMore={hasMore}
          onNeedMore={loadMore}
          sort={sort}
          onSortChange={sortable ? changeSort : undefined}
          windowStartRow={windowStartRow}
          onEditCell={handleEditCell}
          onDeleteRow={columns.some((c) => c.isPrimaryKey) ? handleDeleteRow : undefined}
        />
      </div>

      {showNewRow && (
        <NewRowDialog table={table} columns={columns} onCancel={() => setShowNewRow(false)} onSubmit={handleCreateRow} />
      )}
    </div>
  );
}
