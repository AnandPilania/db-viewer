import type { ColumnDefinition } from "@pilaniaanand/driver-interface";

/**
 * One-off business rules (e.g. "must match a regex") a host app wants
 * enforced pre-submit without touching this module. Synchronous only — add
 * async support later only if something concrete needs a network round trip
 * mid-validation.
 */
export type Validator = (column: ColumnDefinition, raw: string, drafts: Record<string, string>) => string | null;

const validators: Validator[] = [];

export function registerFieldValidator(fn: Validator) {
    validators.push(fn);
}

/** Runs registered validators in registration order, returning the first non-null error. */
export function runCustomValidators(
    column: ColumnDefinition,
    raw: string,
    drafts: Record<string, string>
): string | null {
    for (const fn of validators) {
        const error = fn(column, raw, drafts);
        if (error) return error;
    }
    return null;
}
