import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./index.css";

const EmbedDashboard = lazy(() => import("./components/EmbedDashboard").then((m) => ({ default: m.EmbedDashboard })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Embed links (used in <iframe> on external pages) render a minimal,
// read-only view with none of the app's connection-management chrome —
// matched by path rather than a router since this is the only route split
// the app needs.
const embedMatch = window.location.pathname.match(/^\/embed\/([^/]+)/);
const embedToken = new URLSearchParams(window.location.search).get("token");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {embedMatch && embedToken ? (
        <Suspense fallback={<div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
          <EmbedDashboard dashboardId={embedMatch[1]} token={embedToken} />
        </Suspense>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </React.StrictMode>
);
