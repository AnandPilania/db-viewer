import type { ReactNode } from "react";
import type { ColumnDefinition } from "@pilaniaanand/driver-interface";

/**
 * Structurally identical to the host app's own `GridActionProps`/`GridAction`
 * (apps/web/src/lib/gridActions.ts) — duplicated rather than imported so this
 * package has no dependency back on the app hosting it. `install()` takes the
 * app's real `registerGridAction` as a parameter instead.
 */
export interface GridActionProps {
    connectionId: string;
    table: string;
    columns: ColumnDefinition[];
    onRowCreated: (row: Record<string, unknown>) => void;
    close: () => void;
}

export interface GridAction {
    id: string;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
    render: (props: GridActionProps) => ReactNode;
}

export type RegisterGridAction = (action: GridAction) => void;
