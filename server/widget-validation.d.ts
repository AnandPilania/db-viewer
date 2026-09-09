import type { Widget } from "./models.js";
export type WidgetInput = Omit<Widget, "id" | "createdAt">;
export declare function validateWidgetInput(raw: unknown): WidgetInput;
/** PATCH bodies are partial — validate the merged result so a patch can't sneak a bad field past the full check. */
export declare function validateWidgetPatch(existing: Widget, patch: unknown): WidgetInput;
