import type { Dashboard, DashboardLayoutItem } from "./models.js";
declare class DashboardStore {
    private dashboards;
    constructor();
    private save;
    create(title: string): Dashboard;
    get(id: string): Dashboard;
    list(): Dashboard[];
    updateTitle(id: string, title: string): Dashboard;
    updateLayout(id: string, layout: DashboardLayoutItem[]): Dashboard;
    /** Toggling embedding on (re)generates the share token, so disabling-then-enabling revokes any previously shared link. */
    setEmbedEnabled(id: string, enabled: boolean): Dashboard;
    remove(id: string): void;
}
export declare const dashboardStore: DashboardStore;
export {};
