import { createElement } from "react";
import { NewRowDialog } from "./NewRowDialog.js";
import type { RegisterGridAction } from "./types.js";

export type { GridAction, GridActionProps, RegisterGridAction } from "./types.js";
export { registerFieldValidator } from "./registerFieldValidator.js";

function PlusIcon({ size = 12 }: { size?: number }) {
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
        createElement("line", { x1: 12, y1: 5, x2: 12, y2: 19 }),
        createElement("line", { x1: 5, y1: 12, x2: 19, y2: 12 })
    );
}

/**
 * Registers the "New row" grid action. `registerGridAction` is passed in
 * (rather than imported from the app) so this package has no dependency back
 * on the app hosting it — commenting out the call site's `install(...)` is
 * the concrete proof the module is fully optional.
 */
export function install(registerGridAction: RegisterGridAction): void {
    registerGridAction({
        id: "create-row",
        label: "New row",
        icon: PlusIcon,
        render: (props) =>
            createElement(NewRowDialog, {
                connectionId: props.connectionId,
                table: props.table,
                columns: props.columns,
                onRowCreated: props.onRowCreated,
                close: props.close,
            }),
    });
}
