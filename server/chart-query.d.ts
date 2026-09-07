import type { ConnectionConfig, DriverConnection } from "@pilaniaanand/driver-interface";
import type { Widget } from "./models.js";
export interface WidgetData {
    rows: Record<string, unknown>[];
    xKey: string;
    yKey: string;
}
/**
 * Builds and runs the SQL for a widget's chart, validating every column
 * name the widget references against the table's real, driver-reported
 * schema first. SQL has no parameterized-identifier syntax (only values
 * can be bound with $1/?), so this allowlist check is what stands in for
 * that — a widget can only ever reference a table/column that genuinely
 * exists, never arbitrary interpolated text.
 */
export declare function fetchWidgetData(conn: DriverConnection, config: ConnectionConfig, widget: Widget): Promise<WidgetData>;
