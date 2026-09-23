import type { ComponentType } from "react";
import type { HighlightRule, WidgetData } from "./api.js";

export interface ChartTypeProps {
    data: WidgetData;
    highlightRules?: HighlightRule[];
    /**
     * Fired when the viewer clicks a data point/bar/slice/row. One callback
     * serves both cross-filtering (B2) and drill-to-detail (B3) — which
     * behavior it means is decided per-widget by DashboardBuilder, not here.
     */
    onDataPointClick?: (value: unknown) => void;
}

export type ChartTypeComponent = ComponentType<ChartTypeProps>;

/**
 * The query shape a chart type needs — must match a shape chart-query.ts
 * (server side) actually knows how to build; see that package's
 * chart-shapes.ts for the built-in mapping and how to register a new one.
 * Drives WidgetForm's field visibility/validation so a new chart type gets a
 * working authoring form for free instead of needing its own case there:
 *   - "grouped": x groups the table, y is an aggregate (bar/line/area/pie).
 *   - "raw": ungrouped (x, y) pairs, no aggregation (scatter).
 *   - "number": one aggregate value, no x-axis.
 *   - "table": row grouping (optionally row × column pivot via xField2).
 */
export type ChartShape = "grouped" | "raw" | "number" | "table";

export interface ChartTypeDef {
    label: string;
    shape: ChartShape;
    component: ChartTypeComponent;
}

// ponytail: plain Map registry — mirrors gridActions.ts/navViews.ts. No
// manifest system, no dynamic loading; a module just calls registerChartType
// at load time.
const registry = new Map<string, ChartTypeDef>();

export function registerChartType(key: string, def: ChartTypeDef): void {
    registry.set(key, def);
}

export function getChartType(key: string): ChartTypeComponent | undefined {
    return registry.get(key)?.component;
}

export function getChartTypeDef(key: string): ChartTypeDef | undefined {
    return registry.get(key);
}

export function listChartTypes(): [string, ChartTypeDef][] {
    return [...registry.entries()];
}
