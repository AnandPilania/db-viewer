/**
 * Bare-bones path sync for the top-level app state (connection / view /
 * detail) using the native History API directly. No react-router: this is
 * the only component that needs URL awareness, and a router's nested-route
 * matching, loaders, etc. buy nothing here — see App.tsx for the push/pop
 * wiring.
 *
 * Shape: /c/:connectionId[/:view[/:detail]] — `detail` is whichever sub-
 * resource the active view names: a table under the "data" view (the
 * default, so it's omitted from the path when there's no table yet:
 * /c/:connectionId is equivalent to /c/:connectionId/data), or e.g. an open
 * dashboard's id under a module nav view like "dashboards".
 */
export interface AppRoute {
    connectionId: string | null;
    view: string;
    detail: string | null;
}

export const DEFAULT_VIEW = "data";

export function parseLocation(pathname: string): AppRoute {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "c" || !parts[1]) return { connectionId: null, view: DEFAULT_VIEW, detail: null };
    const connectionId = decodeURIComponent(parts[1]);
    const view = parts[2] ? decodeURIComponent(parts[2]) : DEFAULT_VIEW;
    const detail = parts[3] ? decodeURIComponent(parts[3]) : null;
    return { connectionId, view, detail };
}

export function buildPath(route: AppRoute): string {
    if (!route.connectionId) return "/";
    const segs = ["/c", encodeURIComponent(route.connectionId)];
    if (route.view !== DEFAULT_VIEW || route.detail) {
        segs.push(encodeURIComponent(route.view));
        if (route.detail) segs.push(encodeURIComponent(route.detail));
    }
    return segs.join("/");
}
