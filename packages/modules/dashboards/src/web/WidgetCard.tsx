import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Pencil, Radio } from "lucide-react";
import { ChartRenderer } from "./ChartRenderer.js";
import { useTableRealtime } from "./useTableRealtime.js";
import type { Widget, WidgetData } from "./api.js";

const REFETCH_DEBOUNCE_MS = 750;

interface Props {
    id: string;
    title: string;
    chartType: Widget["chartType"];
    /** "text" cards (B5) have no query at all — fetchData is never called for one. */
    kind?: Widget["kind"];
    content?: Widget["content"];
    fetchData: () => Promise<WidgetData>;
    onRemove?: () => void;
    /** True while a previously-triggered onRemove is still in flight — disables the button so a slow request can't be double-fired. */
    removing?: boolean;
    onEdit?: () => void;
    /** When provided, the header becomes the react-grid-layout drag handle instead of the whole card. */
    dragHandleClassName?: string;
    /** When provided, the widget refetches instantly on any change to this table instead of waiting for the poll interval. */
    connectionId?: string;
    table?: string;
    highlightRules?: Widget["highlightRules"];
    /**
     * Dashboard filter-bar values this widget's filters actually reference
     * (see api.ts's `widgetParamNames`) — folded into the query key so only
     * a widget whose filters use a changed param refetches; a widget with no
     * matching placeholder gets `{}` here and its key never changes.
     */
    params?: Record<string, unknown>;
    /** Fired when the viewer clicks a data point — see ChartTypeProps. Never invoked for a text card. */
    onDataPointClick?: (value: unknown) => void;
}

export function WidgetCard({
    id,
    title,
    chartType,
    kind,
    content,
    fetchData,
    onRemove,
    removing,
    onEdit,
    dragHandleClassName,
    connectionId,
    table,
    highlightRules,
    params,
    onDataPointClick,
}: Props) {
    const isText = kind === "text";
    const queryClient = useQueryClient();
    const queryKey = ["widget-data", id, params ?? {}];

    const { data, isLoading, error } = useQuery({
        queryKey,
        queryFn: fetchData,
        // A text card has nothing to fetch — no `/api/widgets/:id/data` call
        // ever fires for one.
        enabled: !isText,
        // Widgets are aggregates over a whole table, not single rows, so on a
        // change we just refetch the aggregate rather than trying to patch it
        // incrementally — this poll interval is now just a safety net for
        // changes the realtime channel doesn't (or can't) catch.
        refetchInterval: isText ? false : 30_000,
        // A widget kept polling while its tab was in the background; a dashboard
        // left open all day was running its whole aggregate set every 30s for
        // nobody. The realtime channel covers changes while hidden.
        refetchIntervalInBackground: false,
    });

    const isRealtime = !!(connectionId && table);

    // Debounced: a widget's query is an aggregate over a whole table, so a
    // burst of row changes (a bulk insert, a migration) must not turn into one
    // full re-aggregation per changed row. Trailing edge, so the refetch sees
    // the settled state.
    const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (refetchTimer.current) clearTimeout(refetchTimer.current);
        },
        []
    );

    useTableRealtime(connectionId ?? null, table ?? null, () => {
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey });
        }, REFETCH_DEBOUNCE_MS);
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
                            disabled={removing}
                            className="text-muted-foreground hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                            aria-label="Remove widget"
                        >
                            <X size={12} className={removing ? "animate-spin" : undefined} />
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 overflow-hidden p-2">
                {isText ? (
                    <div className="h-full overflow-auto whitespace-pre-wrap text-sm">{content}</div>
                ) : (
                    <>
                        {isLoading && (
                            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                                Loading…
                            </div>
                        )}
                        {error && (
                            <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-destructive">
                                <span>{(error as Error).message}</span>
                                <button
                                    onClick={() => void queryClient.invalidateQueries({ queryKey })}
                                    className="underline hover:no-underline"
                                >
                                    Retry
                                </button>
                            </div>
                        )}
                        {data && (
                            <ChartRenderer
                                chartType={chartType}
                                data={data}
                                highlightRules={highlightRules}
                                onDataPointClick={onDataPointClick}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
