import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalErrorReporting, reportClientError } from "./lib/report-error";
import { registerGridAction } from "./lib/gridActions";
import { registerNavView } from "./lib/navViews";
import { drillToTable } from "./lib/drillNav";
import { install as installRecordCreate } from "@pilaniaanand/module-record-create/web";
import { install as installDashboards } from "@pilaniaanand/module-dashboards/web";
import "./index.css";

installGlobalErrorReporting();

// Commenting this out is the concrete proof the record-creation module is
// fully optional: the "New row" button disappears and getGridActions()
// returns [].
installRecordCreate(registerGridAction);

// Commenting this out is the concrete proof the dashboards module is fully
// optional: the "Dashboards" nav item disappears and getNavViews() returns [].
// `onDrillToTable` is the B3 drill-to-detail boundary: the module calls it
// with a {connectionId, table, column, value}, and drillToTable (lib/drillNav)
// forwards it to whatever handler App.tsx has registered — this module never
// imports App.tsx or TableBrowser directly.
installDashboards(registerNavView, { onDrillToTable: drillToTable });

const EmbedDashboard = lazy(() =>
    import("@pilaniaanand/module-dashboards/web/embed").then((m) => ({ default: m.EmbedDashboard }))
);

// Reporting here is purely for the daily server log — it doesn't replace a
// component's own `isError`/`mutation.isError` handling, which is still
// what the user actually sees.
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
    queryCache: new QueryCache({
        onError: (error, query) =>
            reportClientError(`Query failed [${JSON.stringify(query.queryKey)}]: ${(error as Error).message}`, {
                stack: (error as Error).stack,
            }),
    }),
    mutationCache: new MutationCache({
        onError: (error) =>
            reportClientError(`Mutation failed: ${(error as Error).message}`, { stack: (error as Error).stack }),
    }),
});

// Embed links (used in <iframe> on external pages) render a minimal,
// read-only view with none of the app's connection-management chrome —
// matched by path rather than a router since this is the only route split
// the app needs.
const embedMatch = window.location.pathname.match(/^\/embed\/([^/]+)/);
const embedToken = new URLSearchParams(window.location.search).get("token");

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
                {embedMatch && embedToken ? (
                    <Suspense
                        fallback={
                            <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
                                Loading…
                            </div>
                        }
                    >
                        <EmbedDashboard dashboardId={embedMatch[1]} token={embedToken} />
                    </Suspense>
                ) : (
                    <App />
                )}
            </QueryClientProvider>
        </ErrorBoundary>
    </React.StrictMode>
);
