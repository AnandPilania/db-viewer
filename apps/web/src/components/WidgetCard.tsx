import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Pencil, Radio } from "lucide-react";
import { ChartRenderer } from "@/components/ChartRenderer";
import { useTableRealtime } from "@/hooks/useTableRealtime";
import type { Widget, WidgetData } from "@/lib/api";

interface Props {
  id: string;
  title: string;
  chartType: Widget["chartType"];
  fetchData: () => Promise<WidgetData>;
  onRemove?: () => void;
  onEdit?: () => void;
  /** When provided, the header becomes the react-grid-layout drag handle instead of the whole card. */
  dragHandleClassName?: string;
  /** When provided, the widget refetches instantly on any change to this table instead of waiting for the poll interval. */
  connectionId?: string;
  table?: string;
}

export function WidgetCard({
  id,
  title,
  chartType,
  fetchData,
  onRemove,
  onEdit,
  dragHandleClassName,
  connectionId,
  table,
}: Props) {
  const queryClient = useQueryClient();
  const queryKey = ["widget-data", id];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: fetchData,
    // Widgets are aggregates over a whole table, not single rows, so on a
    // change we just refetch the aggregate rather than trying to patch it
    // incrementally — this poll interval is now just a safety net for
    // changes the realtime channel doesn't (or can't) catch.
    refetchInterval: 30_000,
  });

  const isRealtime = !!(connectionId && table);
  useTableRealtime(connectionId ?? null, table ?? null, () => {
    queryClient.invalidateQueries({ queryKey });
  });

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card">
      <div
        className={`flex items-center justify-between border-b border-border px-3 py-1.5 ${dragHandleClassName ? `${dragHandleClassName} cursor-move` : ""}`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium">{title}</span>
          {isRealtime && (
            <span title="Live updates active" className="shrink-0 text-accent">
              <Radio size={10} />
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onEdit && (
            <button
              onClick={onEdit}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-muted-foreground hover:text-accent"
              aria-label="Edit widget"
            >
              <Pencil size={12} />
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Remove widget"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden p-2">
        {isLoading && <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading…</div>}
        {error && <div className="flex h-full items-center justify-center text-xs text-destructive">{(error as Error).message}</div>}
        {data && <ChartRenderer chartType={chartType} data={data} />}
      </div>
    </div>
  );
}
