import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Download } from "lucide-react";
import { api } from "@/lib/api";
import { useTableRows } from "@/hooks/useTableRows";
import { DataGrid } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";

interface Props {
  connectionId: string;
  table: string;
}

export function TableBrowser({ connectionId, table }: Props) {
  const { rows, columns, loading, hasMore, error, loadMore } = useTableRows(connectionId, table);
  const [wantExact, setWantExact] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const queryClient = useQueryClient();

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
    // A plain navigation lets the browser stream the download straight to
    // disk — no JS buffering of the (potentially huge) result set at all.
    window.location.href = `/api/connections/${connectionId}/tables/${table}/export?format=${format}`;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-medium">{table}</div>
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

          <div className="relative">
            <Button size="sm" variant="secondary" onClick={() => setExportOpen((o) => !o)}>
              <Download size={12} /> Export
            </Button>
            {exportOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-md border border-border bg-card shadow-lg">
                <button
                  onClick={() => startExport("csv")}
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/60"
                >
                  CSV
                </button>
                <button
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
        <DataGrid columns={columns} rows={rows} loading={loading} hasMore={hasMore} onNeedMore={loadMore} />
      </div>
    </div>
  );
}
