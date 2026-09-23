import type { ReactNode } from "react";

export interface NavViewParams {
    /** Sub-resource id from the URL (e.g. an open dashboard's id), or null at the view's landing page. */
    detail: string | null;
    /** Call when the view's internal detail selection changes, to keep the URL in sync. */
    onDetailChange: (detail: string | null) => void;
}

export interface NavView {
    id: string;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
    render: (params: NavViewParams) => ReactNode;
}

// ponytail: plain array registry — mirrors gridActions.ts; one module (dashboards)
// uses this today. Promote to something fancier only when a second consumer needs it.
const views: NavView[] = [];

export function registerNavView(view: NavView) {
    views.push(view);
}

export function getNavViews(): NavView[] {
    return views;
}
