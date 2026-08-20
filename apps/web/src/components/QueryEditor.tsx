import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Square, Download } from "lucide-react";
import type { QuerySpec } from "@db-viewer/driver-interface";
import { api } from "@/lib/api";
import { useStreamingQuery } from "@/hooks/useStreamingQuery";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/DataGrid";
import { SqlEditor } from "@/components/SqlEditor";
import { MongoQueryEditor, type QueryEditorHandle } from "@/components/MongoQueryEditor";
import { RedisQueryEditor } from "@/components/RedisQueryEditor";

interface Props {
  connectionId: string;
  driver: string; // registry key, e.g. "postgres", "mongodb", "redis" — from ConnectionConfig.driver
}

export function QueryEditor({ connectionId, driver }: Props) {
  const [sql, setSql] = useState("SELECT * FROM ");
  const { columns, rows, state, error, durationMs, run, cancel } = useStreamingQuery(connectionId);
  const nonSqlEditorRef = useRef<QueryEditorHandle>(null);

  const { data: driversInfo } = useQuery({
    queryKey: ["drivers"],
    queryFn: api.listDrivers,
    staleTime: Infinity, // capabilities don't change at runtime
  });

  const queryLanguage = useMemo(
    () => driversInfo?.active.find((d) => d.key === driver)?.capabilities.queryLanguage ?? "sql",
    [driversInfo, driver]
  );

  const { data: tables } = useQuery({
    queryKey: ["tables", connectionId],
    queryFn: () => api.listTables(connectionId),
  });

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

  function downloadResults(format: "csv" | "json") {
    const cols = inferredColumns.map((c) => c.name);
    let content: string;
    let mime: string;
    if (format === "csv") {
      const escape = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      content = [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
      mime = "text/csv";
    } else {
      content = JSON.stringify(rows, null, 2);
      mime = "application/json";
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-results.${format === "csv" ? "csv" : "json"}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function runSql() {
    run({ language: "sql", sql });
  }

  function runNonSql(query: QuerySpec) {
    run(query);
  }

  function handleRunClick() {
    if (queryLanguage === "sql") runSql();
    else nonSqlEditorRef.current?.run();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch gap-2 border-b border-border p-2">
        {queryLanguage === "sql" && (
          <div className="h-28 flex-1 overflow-hidden rounded-md border border-input">
            <SqlEditor value={sql} onChange={setSql} tables={tables} onRun={runSql} />
          </div>
        )}
        {queryLanguage === "mongo" && (
          <MongoQueryEditor ref={nonSqlEditorRef} collections={tables} onRun={runNonSql} disabled={state === "running"} />
        )}
        {queryLanguage === "redis-command" && (
          <RedisQueryEditor ref={nonSqlEditorRef} onRun={runNonSql} disabled={state === "running"} />
        )}
        <div className="flex flex-col gap-1">
          {state === "running" ? (
            <Button size="sm" variant="destructive" onClick={cancel}>
              <Square size={14} /> Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={handleRunClick} disabled={!connectionId}>
              <Play size={14} /> Run
            </Button>
          )}
          <span className="text-center text-[10px] text-muted-foreground">⌘/Ctrl+Enter</span>
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

        {rows.length > 0 && (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => downloadResults("csv")}>
              <Download size={12} /> CSV
            </Button>
            <Button size="sm" variant="ghost" onClick={() => downloadResults("json")}>
              <Download size={12} /> JSON
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        <DataGrid columns={inferredColumns} rows={rows} loading={false} hasMore={false} onNeedMore={() => {}} />
      </div>
    </div>
  );
}
