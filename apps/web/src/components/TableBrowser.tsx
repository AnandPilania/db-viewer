import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash, Download, Plus, Radio } from "lucide-react";
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
  const { rows, columns, loading, hasMore, error, loadMore, updateLocalCell, prependRow, removeLocalRowAt, applyChangeEvent } =
    useTableRows(connectionId, table);
  const [wantExact, setWantExact] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [showNewRow, setShowNewRow] = useState(false);

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

  function startExport(format: "csv" | "ndjson") {
    setExportOpen(false);
    window.location.href = `/api/connections/${connectionId}/tables/${table}/export?format=${format}`;
  }

  async function handleEditCell(rowIndex: number, column: ColumnDefinition, value: unknown): Promise<boolean> {
    const row = rows[rowIndex];
    const primaryKey = Object.fromEntries(
      columns.filter((c) => c.isPrimaryKey).map((c) => [c.name, row[c.name]])
    );
    if (Object.keys(primaryKey).length === 0) return false;

    const previous = row[column.name];
    updateLocalCell(rowIndex, column.name, value); // optimistic
    try {
      await api.updateCell(connectionId, table, { primaryKey, column: column.name, value });
      return true;
    } catch {
      updateLocalCell(rowIndex, column.name, previous); // rollback
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

    removeLocalRowAt(rowIndex); // optimistic
    try {
      await api.deleteRow(connectionId, table, { primaryKey });
    } catch {
      prependRow(row); // rollback — simplest safe recovery, re-adds at top rather than exact position
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {table}
          <span title="Live updates active" className="text-accent">
            <Radio size={11} />
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Hash size={12} />
          {exact ? (
            <span>{exact.value.toLocaleString()} rows (exact)</span>
          ) : estimate ? (
            <span>~{estimate.value.toLocaleString()} rows (estimate)</span>
          ) : (
            <span>counting…</span>
          )}
          {!wantExact && (
            <Button size="sm" variant="ghost" onClick={() => setWantExact(true)} disabled={exactLoading}>
              Get exact count
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

      <div className="flex-1 overflow-hidden">
        <DataGrid
          columns={columns}
          rows={rows}
          loading={loading}
          hasMore={hasMore}
          onNeedMore={loadMore}
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
