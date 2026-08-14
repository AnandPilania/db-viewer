import { useState } from "react";
import { Play, Square } from "lucide-react";
import { useStreamingQuery } from "@/hooks/useStreamingQuery";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/DataGrid";

interface Props {
  connectionId: string | null;
}

export function QueryEditor({ connectionId }: Props) {
  const [sql, setSql] = useState("SELECT * FROM ");
  const { columns, rows, state, error, durationMs, run, cancel } = useStreamingQuery(connectionId);

  const inferredColumns =
    columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0]).map((name) => ({
            name,
            type: "unknown" as const,
            nativeType: "",
            nullable: true,
            isPrimaryKey: false,
            isForeignKey: false,
          }))
        : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={3}
          spellCheck={false}
          className="flex-1 resize-none rounded-md border border-input bg-card p-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="SELECT * FROM my_table WHERE ..."
        />
        <div className="flex flex-col gap-1">
          {state === "running" ? (
            <Button size="sm" variant="destructive" onClick={cancel}>
              <Square size={14} /> Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={() => run(sql)} disabled={!connectionId}>
              <Play size={14} /> Run
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {state === "running" && <span>Streaming… {rows.length.toLocaleString()} rows so far</span>}
        {state === "done" && (
          <span>
            Done — {rows.length.toLocaleString()} rows in {durationMs?.toFixed(1)}ms
          </span>
        )}
        {state === "cancelled" && <span>Cancelled after {rows.length.toLocaleString()} rows</span>}
        {state === "error" && <span className="text-destructive">{error}</span>}
        {state === "idle" && <span>Ready</span>}
      </div>

      <div className="flex-1 overflow-hidden">
        <DataGrid columns={inferredColumns} rows={rows} loading={false} hasMore={false} onNeedMore={() => {}} />
      </div>
    </div>
  );
}
