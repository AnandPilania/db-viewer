import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { ChartRenderer } from "@/components/ChartRenderer";
import type { WidgetData } from "@/lib/api";

interface PublicWidget {
  id: string;
  title: string;
  chartType: "bar" | "line" | "pie" | "number" | "table";
  layout: { x: number; y: number; w: number; h: number };
}

interface PublicDashboard {
  id: string;
  title: string;
  widgets: PublicWidget[];
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
  onChangeRef.current = onChange;

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

function EmbedWidget({ dashboardId, token, widget }: { dashboardId: string; token: string; widget: PublicWidget }) {
  const queryClient = useQueryClient();
  const queryKey = ["embed-widget-data", dashboardId, widget.id];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      fetchJson<WidgetData>(`/api/public/dashboards/${dashboardId}/widgets/${widget.id}/data?token=${token}`),
    refetchInterval: 60_000,
  });

  usePublicWidgetRealtime(dashboardId, token, widget.id, () => {
    queryClient.invalidateQueries({ queryKey });
  });

  return (
    <div
      style={{ gridColumn: `span ${widget.layout.w} / span ${widget.layout.w}`, gridRow: `span ${widget.layout.h} / span ${widget.layout.h}` }}
      className="flex flex-col rounded-lg border border-border bg-card"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs font-medium">
        {widget.title}
        <span title="Live updates active" className="text-accent">
          <Radio size={10} />
        </span>
      </div>
      <div className="flex-1 overflow-hidden p-2">
        {isLoading && <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading…</div>}
        {error && <div className="flex h-full items-center justify-center text-xs text-destructive">{(error as Error).message}</div>}
        {data && <ChartRenderer chartType={widget.chartType} data={data} />}
      </div>
    </div>
  );
}

export function EmbedDashboard({ dashboardId, token }: { dashboardId: string; token: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["embed-dashboard", dashboardId],
    queryFn: () => fetchJson<PublicDashboard>(`/api/public/dashboards/${dashboardId}?token=${token}`),
  });

  if (isLoading) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (error) return <div className="flex h-screen items-center justify-center text-sm text-destructive">{(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="h-screen overflow-auto bg-background p-3">
      <div className="mb-3 text-sm font-medium">{data.title}</div>
      <div className="grid auto-rows-[28px] grid-cols-12 gap-3">
        {data.widgets.map((w) => (
          <EmbedWidget key={w.id} dashboardId={dashboardId} token={token} widget={w} />
        ))}
      </div>
    </div>
  );
}
