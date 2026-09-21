import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnDefinition, QuerySpec } from "@pilaniaanand/driver-interface";

type StreamState = "idle" | "running" | "done" | "error" | "cancelled";

/**
 * Hard cap on rows held in the browser for an ad-hoc query.
 *
 * The results pane used to append every chunk without limit, so a `SELECT *`
 * against a large table streamed until the tab ran out of memory — the server
 * happily kept feeding it. Past this point the client cancels the stream and
 * says so; the export endpoint is the right tool for pulling a whole table.
 */
const MAX_ROWS = 50_000;

interface StreamResult {
    columns: ColumnDefinition[];
    rows: Record<string, unknown>[];
    state: StreamState;
    error: string | null;
    durationMs: number | null;
    /** Set when the stream was stopped by MAX_ROWS rather than by the server finishing. */
    truncated: boolean;
    /** Rows received so far — same as rows.length, but keeps counting if truncated. */
    received: number;
}

const IDLE: StreamResult = {
    columns: [],
    rows: [],
    state: "idle",
    error: null,
    durationMs: null,
    truncated: false,
    received: 0,
};

export function useStreamingQuery(connectionId: string | null) {
    const [result, setResult] = useState<StreamResult>(IDLE);
    const wsRef = useRef<WebSocket | null>(null);

    /**
     * Closes the socket without letting its handlers write state afterwards.
     * The old implementation had no cleanup at all: navigating away mid-query
     * left the socket open, the server-side cursor streaming, and setState
     * firing into an unmounted component.
     */
    const teardown = useCallback(() => {
        const ws = wsRef.current;
        wsRef.current = null;
        if (!ws) return;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onopen = null;
        ws.close();
    }, []);

    useEffect(() => teardown, [teardown]);

    const run = useCallback(
        (query: QuerySpec) => {
            if (!connectionId) return;
            teardown();

            setResult({ ...IDLE, state: "running" });

            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const ws = new WebSocket(
                `${protocol}//${window.location.host}/ws/connections/${encodeURIComponent(connectionId)}/stream`
            );
            wsRef.current = ws;

            ws.onopen = () => ws.send(JSON.stringify({ type: "run", query }));

            ws.onmessage = (event) => {
                if (wsRef.current !== ws) return; // superseded by a newer run
                let msg: {
                    type: string;
                    rows?: Record<string, unknown>[];
                    columns?: ColumnDefinition[];
                    message?: string;
                    durationMs?: number;
                };
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (msg.type === "chunk") {
                    setResult((prev) => {
                        if (prev.truncated) return prev;
                        const incoming = msg.rows ?? [];
                        const room = MAX_ROWS - prev.rows.length;
                        if (incoming.length > room) {
                            // Tell the server to stop rather than just dropping
                            // rows on the floor — otherwise it keeps scanning.
                            ws.send(JSON.stringify({ type: "cancel" }));
                            return {
                                ...prev,
                                columns: prev.columns.length ? prev.columns : (msg.columns ?? []),
                                rows: [...prev.rows, ...incoming.slice(0, Math.max(0, room))],
                                received: prev.received + incoming.length,
                                truncated: true,
                                state: "done",
                            };
                        }
                        return {
                            ...prev,
                            columns: prev.columns.length ? prev.columns : (msg.columns ?? []),
                            rows: [...prev.rows, ...incoming],
                            received: prev.received + incoming.length,
                        };
                    });
                } else if (msg.type === "done") {
                    setResult((prev) =>
                        prev.truncated ? prev : { ...prev, state: "done", durationMs: msg.durationMs ?? null }
                    );
                } else if (msg.type === "cancelled") {
                    setResult((prev) => (prev.truncated ? prev : { ...prev, state: "cancelled" }));
                } else if (msg.type === "error") {
                    setResult((prev) => ({ ...prev, state: "error", error: msg.message ?? "Query failed" }));
                }
            };

            ws.onerror = () => {
                if (wsRef.current !== ws) return;
                setResult((prev) =>
                    // A socket error after the stream already finished is just
                    // the connection closing; don't overwrite a good result.
                    prev.state === "running" ? { ...prev, state: "error", error: "WebSocket connection failed" } : prev
                );
            };
        },
        [connectionId, teardown]
    );

    const cancel = useCallback(() => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cancel" }));
    }, []);

    return { ...result, maxRows: MAX_ROWS, run, cancel };
}
