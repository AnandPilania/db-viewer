import type { ReactNode } from "react";
import type { ColumnDefinition } from "@pilaniaanand/driver-interface";

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

// ponytail: plain array registry — one module (record-creation) uses this today;
// promote to something fancier only when a second consumer needs it.
const actions: GridAction[] = [];

export function registerGridAction(action: GridAction) {
    actions.push(action);
}

export function getGridActions(): GridAction[] {
    return actions;
}
