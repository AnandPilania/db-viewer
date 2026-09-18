import { type ConnectionConfig, type DriverConnection } from "@pilaniaanand/driver-interface";
import type { Widget } from "./models.js";
export interface WidgetData {
    rows: Record<string, unknown>[];
    xKey: string;
    yKey: string;
    /** Set only for a "table" widget with both xField and xField2 — signals a row × column pivot, keyed by this field, rather than a flat grouped list. */
    x2Key?: string;
}
/**
 * Runs a widget's query, coalescing concurrent and near-repeat requests.
 *
 * Keyed on the widget's full definition rather than its id, so editing a
 * widget takes effect immediately instead of after the TTL — and on the
 * connection id, so two widgets that differ only by connection never share
 * a result.
 */
export declare function fetchWidgetData(conn: DriverConnection, config: ConnectionConfig, widget: Widget): Promise<WidgetData>;
