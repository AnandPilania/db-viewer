import { useEffect, useRef } from "react";

export interface RowChangeEvent {
  type: "insert" | "update" | "delete";
  row?: Record<string, unknown>;
  primaryKey?: Record<string, unknown>;
  column?: string;
  value?: unknown;
}

type Handler = (event: RowChangeEvent) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One WebSocket per (connection, table), shared by every hook instance
 * watching it.
 *
 * Each caller used to open its own socket. A dashboard with twenty widgets on
 * one table opened twenty sockets, and each one made the server refcount a
 * separate native watcher — so the browser held twenty connections and the
 * database got twenty change streams for one table's worth of information.
 * React StrictMode's double-effect doubled that again in development.
 */
interface Channel {
  socket: WebSocket | null;
  handlers: Set<Handler>;
  /** Consecutive failed connects, for exponential backoff. */
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const channels = new Map<string, Channel>();

function connect(key: string, connectionId: string, table: string) {
  const channel = channels.get(key);
  if (!channel || channel.closed) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws/connections/${encodeURIComponent(
    connectionId
  )}/tables/${encodeURIComponent(table)}/watch`;

  const socket = new WebSocket(url);
  channel.socket = socket;

  socket.onopen = () => {
    channel.attempts = 0;
  };

  socket.onmessage = (event) => {
    let parsed: RowChangeEvent;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return; // ignore malformed frame
    }
    // Copied before iterating: a handler may unsubscribe during dispatch.
    for (const handler of [...channel.handlers]) {
      try {
        handler(parsed);
      } catch {
        /* one bad subscriber must not stop the others */
      }
    }
  };

  socket.onclose = () => {
    channel.socket = null;
    if (channel.closed || channel.handlers.size === 0) return;
    // Exponential backoff with jitter. A flat 2s retry meant every open tab
    // hammered the server in lockstep for as long as it was down.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** channel.attempts);
    channel.attempts++;
    channel.reconnectTimer = setTimeout(() => connect(key, connectionId, table), delay * (0.5 + Math.random()));
  };
}

function subscribe(connectionId: string, table: string, handler: Handler): () => void {
  const key = `${connectionId}::${table}`;
  let channel = channels.get(key);

  if (!channel) {
    channel = { socket: null, handlers: new Set(), attempts: 0, reconnectTimer: null, closed: false };
    channels.set(key, channel);
    connect(key, connectionId, table);
  }
  channel.handlers.add(handler);

  return () => {
    const current = channels.get(key);
    if (!current) return;
    current.handlers.delete(handler);
    if (current.handlers.size > 0) return;
    // Last subscriber left — tear the channel down so the server can release
    // its native watcher too.
    current.closed = true;
    if (current.reconnectTimer) clearTimeout(current.reconnectTimer);
    current.socket?.close();
    channels.delete(key);
  };
}

/**
 * Subscribes to /ws/connections/:id/tables/:table/watch and forwards every
 * insert/update/delete event to onChange. Reconnects with backoff if the
 * socket drops (e.g. dev server restart) rather than silently going stale.
 */
export function useTableRealtime(connectionId: string | null, table: string | null, onChange: Handler) {
  // Held in a ref so a caller passing a fresh closure each render doesn't
  // resubscribe — which would tear down and rebuild the shared socket.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!connectionId || !table) return;
    return subscribe(connectionId, table, (event) => onChangeRef.current(event));
  }, [connectionId, table]);
}
