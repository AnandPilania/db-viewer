import type { Widget } from "./models.js";
declare class WidgetStore {
    private widgets;
    constructor();
    private save;
    create(input: Omit<Widget, "id" | "createdAt">): Widget;
    update(id: string, patch: Partial<Omit<Widget, "id" | "createdAt">>): Widget;
    get(id: string): Widget;
    list(): Widget[];
    remove(id: string): void;
}
export declare const widgetStore: WidgetStore;
export {};
