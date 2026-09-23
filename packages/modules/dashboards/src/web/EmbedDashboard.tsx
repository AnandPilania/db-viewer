import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { ChartRenderer } from "./ChartRenderer.js";
import { ParameterFilterBar } from "./ParameterFilterBar.js";
import type { DashboardParameter, HighlightRule, WidgetData } from "./api.js";

interface PublicWidget {
    id: string;
    title: string;
    chartType: "bar" | "line" | "area" | "scatter" | "pie" | "number" | "table";
    highlightRules?: HighlightRule[];
    layout: { x: number; y: number; w: number; h: number };
}

interface PublicDashboard {
    id: string;
    title: string;
    widgets: PublicWidget[];
    /**
     * Filter-bar controls the viewer may adjust. With a plain opaque
     * shareToken this is every dashboard parameter (today's unrestricted
     * behavior). With a signed embed token (Part C), the server has already
     * dropped any parameter the token locked — those render no control here
     * at all, not even a disabled one.
     */
    parameters?: DashboardParameter[];
}

function paramsQuery(params: Record<string, unknown>): string {
    const nonEmpty = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
    return Object.keys(nonEmpty).length ? `&params=${encodeURIComponent(JSON.stringify(nonEmpty))}` : "";
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
    return body;
}

/**
 * Subscribes to the public, token-gated "changed" ping for one widget and
 * triggers a refetch — deliberately not the full row-level watch channel
 * the authenticated app uses, since this one is reachable from any
 * external page embedding the dashboard (see routes/public-watch.ts).
 */
function usePublicWidgetRealtime(dashboardId: string, token: string, widgetId: string, onChange: () => void) {
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    });

    useEffect(() => {
        let ws: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;

        function connect() {
            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(
                `${protocol}//${window.location.host}/ws/public/dashboards/${dashboardId}/widgets/${widgetId}/watch?token=${token}`
            );
            ws.onmessage = () => onChangeRef.current();
            ws.onclose = () => {
                if (stopped) return;
                reconnectTimer = setTimeout(connect, 3000);
            };
        }
        connect();

        return () => {
            stopped = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
        };
    }, [dashboardId, token, widgetId]);
}

function EmbedWidget({
    dashboardId,
    token,
    widget,
    params,
}: {
    dashboardId: string;
    token: string;
    widget: PublicWidget;
    params: Record<string, unknown>;
}) {
    const queryClient = useQueryClient();
    const queryKey = ["embed-widget-data", dashboardId, widget.id, params];

    const { data, isLoading, error } = useQuery({
        queryKey,
        queryFn: () =>
            fetchJson<WidgetData>(
                `/api/public/dashboards/${dashboardId}/widgets/${widget.id}/data?token=${token}${paramsQuery(params)}`
            ),
        refetchInterval: 60_000,
    });

    usePublicWidgetRealtime(dashboardId, token, widget.id, () => {
        queryClient.invalidateQueries({ queryKey });
    });

    return (
        <div
            style={{
                gridColumn: `span ${widget.layout.w} / span ${widget.layout.w}`,
                gridRow: `span ${widget.layout.h} / span ${widget.layout.h}`,
            }}
            className="flex flex-col rounded-lg border border-border bg-card"
        >
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs font-medium">
                {widget.title}
                <span title="Live updates active" className="text-accent">
                    <Radio size={10} />
                </span>
            </div>
            <div className="flex-1 overflow-hidden p-2">
                {isLoading && (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        Loading…
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center text-xs text-destructive">
                        {(error as Error).message}
                    </div>
                )}
                {data && (
                    <ChartRenderer chartType={widget.chartType} data={data} highlightRules={widget.highlightRules} />
                )}
            </div>
        </div>
    );
}

export function EmbedDashboard({ dashboardId, token }: { dashboardId: string; token: string }) {
    const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
    const defaultsSeeded = useRef(false);

    const { data, isLoading, error } = useQuery({
        queryKey: ["embed-dashboard", dashboardId],
        queryFn: () => fetchJson<PublicDashboard>(`/api/public/dashboards/${dashboardId}?token=${token}`),
    });

    // Seed the filter bar from each adjustable parameter's defaultValue once,
    // the first time the dashboard shell arrives — same rationale as
    // DashboardBuilder's identical effect: not on every refetch, or a
    // viewer's in-progress edit would get stomped back to the default.
    useEffect(() => {
        if (!data || defaultsSeeded.current) return;
        defaultsSeeded.current = true;
        const defaults: Record<string, unknown> = {};
        for (const p of data.parameters ?? []) {
            if (p.defaultValue !== undefined) defaults[p.name] = p.defaultValue;
        }
        setParamValues(defaults);
    }, [data]);

    if (isLoading)
        return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
    if (error)
        return (
            <div className="flex h-screen items-center justify-center text-sm text-destructive">
                {(error as Error).message}
            </div>
        );
    if (!data) return null;

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-background">
            <div className="p-3 pb-0 text-sm font-medium">{data.title}</div>
            <ParameterFilterBar
                parameters={data.parameters ?? []}
                values={paramValues}
                onChange={(name, value) => setParamValues((v) => ({ ...v, [name]: value }))}
            />
            <div className="flex-1 overflow-auto p-3">
                <div className="grid auto-rows-[28px] grid-cols-12 gap-3">
                    {data.widgets.map((w) => (
                        <EmbedWidget
                            key={w.id}
                            dashboardId={dashboardId}
                            token={token}
                            widget={w}
                            params={paramValues}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
