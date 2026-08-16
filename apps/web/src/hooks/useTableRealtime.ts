import { useEffect, useRef } from "react";

export interface RowChangeEvent {
  type: "insert" | "update" | "delete";
  row?: Record<string, unknown>;
  primaryKey?: Record<string, unknown>;
  column?: string;
  value?: unknown;
}

/**
 * Subscribes to /ws/connections/:id/tables/:table/watch and forwards every
 * insert/update/delete event to onChange. Reconnects automatically if the
 * socket drops (e.g. dev server restart) rather than silently going stale.
 */
export function useTableRealtime(
  connectionId: string | null,
  table: string | null,
  onChange: (event: RowChangeEvent) => void
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!connectionId || !table) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/connections/${connectionId}/tables/${table}/watch`);

      ws.onmessage = (event) => {
        try {
          onChangeRef.current(JSON.parse(event.data));
        } catch {
          /* ignore malformed frame */
        }
      };

      ws.onclose = () => {
        if (stopped) return;
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [connectionId, table]);
}
