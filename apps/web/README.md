# web

The [db-viewer](../../README.md) frontend: React + Vite + Tailwind, talking
to the server over REST and WebSocket.

## Running

```bash
pnpm dev          # vite, :5173, proxies /api and /ws to :4000
pnpm build        # tsc -b && vite build -> dist/ (served by the server in production)
pnpm preview
pnpm typecheck
```

Needs `apps/server` running separately in dev (`pnpm dev:server` from the
repo root) — this only serves the UI; every read/write goes through the
server's API.

## Layout

- **`lib/api.ts`** — thin `fetch` wrapper typed against
  `@pilaniaanand/driver-interface`; every request/response shape comes from
  that shared package, not duplicated types.
- **`lib/report-error.ts`** — POSTs a frontend error to the server's
  `/api/client-errors` route, fire-and-forget, so it lands in the same
  daily-rotating log file as server-side errors instead of only ever being
  visible in one user's browser console.
- **`components/ErrorBoundary.tsx`** — wraps the app root; a render crash
  shows a fallback instead of a white screen, and reports via
  `report-error.ts`. `main.tsx` also wires `window.onerror`/
  `unhandledrejection` and a react-query global `onError` through the same
  reporter, so a failure is never silently invisible even if a component
  doesn't explicitly check `isError`.
- **`components/ConnectionForm.tsx`** — the connection dialog: driver picker,
  host/port/credentials, plus collapsible sections for TLS client
  certificates and SSH tunnel (PEM/PPK, paste or upload — file inputs read
  as text client-side, no multipart upload plumbing needed since these are
  all plain-text formats) and a "read-only connection" toggle.
- **`components/DataGrid.tsx`** — virtualized (TanStack Virtual) table
  browser: constant DOM node count regardless of table size, arrow-key
  navigation, inline cell editing.
- **`components/SqlEditor.tsx`** / **`MongoQueryEditor.tsx`** /
  **`RedisQueryEditor.tsx`** — one per `queryLanguage` the active driver
  reports; `QueryEditor.tsx` picks which to render. The SQL editor is Monaco
  with schema-aware autocomplete (table/column suggestions from the
  connection's real schema) and a Ctrl/⌘-Enter run action.
- **`components/ERDiagram.tsx`** / **`TableNode.tsx`** — foreign-key diagram
  via React Flow + dagre auto-layout.
- **`components/DashboardBuilder.tsx`** / **`WidgetForm.tsx`** /
  **`WidgetCard.tsx`** / **`ChartRenderer.tsx`** — the dashboard builder:
  drag-and-resize grid layout (react-grid-layout, debounce-persisted),
  chart widgets (Recharts) backed by validated server-side queries.
- **`components/EmbedDashboard.tsx`** — the public, token-gated view a
  dashboard's embed link opens; only ever replays a widget's pre-saved
  query, never accepts arbitrary SQL/table/column input.
- **`hooks/useTableRows.ts`** — pagination + optimistic local edits for the
  data grid; applies incoming realtime events idempotently (matched by
  primary key, not array position) so a client's own optimistic update and
  the server's echo of that same change never double-apply.
- **`hooks/useTableRealtime.ts`** — subscribes to
  `/ws/connections/:id/tables/:table/watch`.
- **`hooks/useStreamingQuery.ts`** — drives the SQL editor's WebSocket query
  stream, chunk by chunk, cancellable mid-flight.
- **`lib/local-prefs.ts`** — the only thing kept in `localStorage`: the last
  active connection id. Everything else (connection list, credentials never
  included) comes fresh from the server on every load.

## Keyboard support

- **Ctrl/⌘ K** — command palette
- **?** — keyboard shortcuts help (suppressed while typing in a text field)
- **Data grid** — arrow keys navigate, Enter edits, Escape cancels,
  Delete/Backspace deletes (behind a confirm)
- **SQL editor** — Ctrl/⌘ Enter runs the query
- Every dialog traps Tab focus and closes on Escape via one shared `Modal`
  wrapper (`components/ui/modal.tsx`)
