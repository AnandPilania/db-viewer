import { createElement, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import type { DrillTarget } from "./DashboardBuilder.js";

// Re-exported so a host app or another module can add a chart type (e.g. a
// heatmap or funnel) without forking this package — see chartTypes.ts's
// doc comment for the shape a new type must declare.
export { registerChartType, type ChartTypeDef, type ChartShape, type ChartTypeProps } from "./chartTypes.js";

// EmbedDashboard is exported from its own "./web/embed" subpath (not
// re-exported here) so main.tsx's dynamic import of it for the /embed/:id
// route doesn't collide with this module's own static "./web" import (used
// for `install`) and get merged into one eagerly-loaded chunk.

/**
 * Options this module accepts at install time — the dependency-injection
 * boundary for B3's drill-to-detail, which needs to navigate the *host app's*
 * table browser. This package never imports anything from apps/web/src
 * directly; the host app supplies the one callback it needs instead (see
 * apps/web/src/main.tsx and apps/web/src/lib/drillNav.ts).
 */
export interface DashboardsInstallOptions {
    onDrillToTable?: (target: DrillTarget) => void;
}

// Lazy, same as the app's own code-split views (QueryEditor/ERDiagram) —
// keeps recharts/react-grid-layout out of the main bundle until the
// Dashboards nav view is actually opened, matching pre-extraction behavior.
// Cast to a concrete props type: without it, `lazy`'s inference through the
// `.then()` reshaping loses DashboardsPage's real prop type and widens to
// `{}`, which then rejects `onDrillToTable` below as an unknown prop.
const DashboardsPage = lazy(() =>
    import("./DashboardsPage.js").then((m) => ({
        default: m.DashboardsPage as ComponentType<DashboardsInstallOptions & NavViewParams>,
    }))
);

function DashboardsView({ onDrillToTable, detail, onDetailChange }: DashboardsInstallOptions & NavViewParams) {
    return createElement(
        Suspense,
        {
            fallback: createElement(
                "div",
                { className: "flex h-full items-center justify-center text-sm text-muted-foreground" },
                "Loading…"
            ),
        },
        createElement(DashboardsPage, { onDrillToTable, detail, onDetailChange })
    );
}

interface NavViewParams {
    /** Sub-resource id from the host app's URL (e.g. an open dashboard's id), or null at the view's landing page. */
    detail: string | null;
    /** Call when the view's internal detail selection changes, to keep the host app's URL in sync. */
    onDetailChange: (detail: string | null) => void;
}

interface NavView {
    id: string;
    label: string;
    icon: ComponentType<{ size?: number }>;
    render: (params: NavViewParams) => ReactNode;
}

function LayoutGridIcon({ size = 12 }: { size?: number }) {
    return createElement(
        "svg",
        {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
        },
        createElement("rect", { x: 3, y: 3, width: 7, height: 7, rx: 1 }),
        createElement("rect", { x: 14, y: 3, width: 7, height: 7, rx: 1 }),
        createElement("rect", { x: 14, y: 14, width: 7, height: 7, rx: 1 }),
        createElement("rect", { x: 3, y: 14, width: 7, height: 7, rx: 1 })
    );
}

/**
 * Registers the "Dashboards" nav view. `registerNavView` is passed in
 * (rather than imported from the app) so this package has no dependency
 * back on the app hosting it — commenting out the call site's `install(...)`
 * is the concrete proof the module is fully optional.
 */
export function install(registerNavView: (view: NavView) => void, options: DashboardsInstallOptions = {}): void {
    registerNavView({
        id: "dashboards",
        label: "Dashboards",
        icon: LayoutGridIcon,
        render: (params: NavViewParams) => createElement(DashboardsView, { ...options, ...params }),
    });
}
