export type ChartShape = "grouped" | "raw" | "number" | "table";

/**
 * Maps an author-facing chart type to the query shape chart-query.ts
 * actually builds. Multiple chart types can share one shape — "pivot" is a
 * distinct picker option (registered web-side in chartTypes.ts) but queries
 * exactly like "table" (see chart-query.ts's comment on that branch). A new
 * chart type added purely on the web side (a different renderer/label)
 * reuses one of these four shapes instead of needing its own branch in
 * chart-query.ts — register it here with the shape it queries like.
 */
const shapes = new Map<string, ChartShape>([
    ["bar", "grouped"],
    ["line", "grouped"],
    ["area", "grouped"],
    ["pie", "grouped"],
    ["scatter", "raw"],
    ["number", "number"],
    ["table", "table"],
    ["pivot", "table"],
]);

export function registerChartTypeShape(chartType: string, shape: ChartShape): void {
    shapes.set(chartType, shape);
}

export function chartShapeOf(chartType: string): ChartShape | undefined {
    return shapes.get(chartType);
}

export function registeredChartTypes(): string[] {
    return [...shapes.keys()];
}
