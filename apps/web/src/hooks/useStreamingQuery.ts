import { useCallback, useRef, useState } from "react";
import type { ColumnDefinition, QuerySpec } from "@db-viewer/driver-interface";

type StreamState = "idle" | "running" | "done" | "error" | "cancelled";

interface StreamResult {
  columns: ColumnDefinition[];
  rows: Record<string, unknown>[];
  state: StreamState;
  error: string | null;
  durationMs: number | null;
}

export function useStreamingQuery(connectionId: string | null) {
  const [result, setResult] = useState<StreamResult>({
    columns: [],
    rows: [],
    state: "idle",
    error: null,
    durationMs: null,
  });
  const wsRef = useRef<WebSocket | null>(null);

  const run = useCallback(
    (query: QuerySpec) => {
      if (!connectionId) return;
      wsRef.current?.close();

      setResult({ columns: [], rows: [], state: "running", error: null, durationMs: null });

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/connections/${connectionId}/stream`);
      wsRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: "run", query }));

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "chunk") {
          setResult((prev) => ({
            ...prev,
            columns: prev.columns.length ? prev.columns : msg.columns,
            rows: [...prev.rows, ...msg.rows],
          }));
        } else if (msg.type === "done") {
          setResult((prev) => ({ ...prev, state: "done", durationMs: msg.durationMs }));
        } else if (msg.type === "cancelled") {
          setResult((prev) => ({ ...prev, state: "cancelled" }));
        } else if (msg.type === "error") {
          setResult((prev) => ({ ...prev, state: "error", error: msg.message }));
        }
      };

      ws.onerror = () => setResult((prev) => ({ ...prev, state: "error", error: "WebSocket connection failed" }));
    },
    [connectionId]
  );

  const cancel = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "cancel" }));
  }, []);

  return { ...result, run, cancel };
}
