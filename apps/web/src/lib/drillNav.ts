/**
 * The dashboards module → app-shell → TableBrowser navigation boundary for
 * drill-to-detail (B3). The dashboards module never imports anything from
 * apps/web/src directly (same rule as record-create's grid-action hook) — it
 * only calls whatever `onDrillToTable` callback its install() was given. This
 * is that callback's other end: App.tsx registers a handler here once (see
 * its useEffect), and main.tsx passes `drillToTable` itself into
 * `installDashboards(...)`'s options, closing the loop without either side
 * importing the other.
 */
export interface DrillTarget {
    connectionId: string;
    table: string;
    column: string;
    value: unknown;
}

let handler: ((target: DrillTarget) => void) | null = null;

export function setDrillHandler(fn: (target: DrillTarget) => void): void {
    handler = fn;
}

export function drillToTable(target: DrillTarget): void {
    handler?.(target);
}
