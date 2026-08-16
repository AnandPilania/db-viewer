import type { ColumnDefinition } from "@db-viewer/driver-interface";

export interface ValidationResult {
  valid: boolean;
  value: unknown;
  error: string | null;
}

/**
 * Parses and validates a raw string (from an <input>) against a column's
 * declared type. Used both for inline cell edits and new-record creation so
 * the two can't drift apart on what counts as a valid value.
 */
export function validateValue(raw: string, column: ColumnDefinition): ValidationResult {
  const trimmed = raw.trim();

  if (trimmed === "") {
    if (column.nullable) return { valid: true, value: null, error: null };
    if (column.defaultValue !== null && column.defaultValue !== undefined) {
      // Empty + has a DB default (e.g. a sequence or CURRENT_TIMESTAMP) — let the database fill it in.
      return { valid: true, value: undefined, error: null };
    }
    return { valid: false, value: raw, error: `${column.name} is required` };
  }

  switch (column.type) {
    case "number": {
      const n = Number(trimmed);
      if (Number.isNaN(n)) return { valid: false, value: raw, error: `${column.name} must be a number` };
      return { valid: true, value: n, error: null };
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (["true", "1", "yes"].includes(lower)) return { valid: true, value: true, error: null };
      if (["false", "0", "no"].includes(lower)) return { valid: true, value: false, error: null };
      return { valid: false, value: raw, error: `${column.name} must be true or false` };
    }
    case "date":
    case "datetime": {
      const d = new Date(trimmed);
      if (Number.isNaN(d.getTime())) return { valid: false, value: raw, error: `${column.name} must be a valid date` };
      return { valid: true, value: column.type === "date" ? trimmed : d.toISOString(), error: null };
    }
    case "json": {
      try {
        return { valid: true, value: JSON.parse(trimmed), error: null };
      } catch {
        return { valid: false, value: raw, error: `${column.name} must be valid JSON` };
      }
    }
    case "binary":
      // Accepted as-is (base64 or raw string); drivers are responsible for encoding.
      return { valid: true, value: trimmed, error: null };
    case "string":
    case "null":
    case "unknown":
    default:
      return { valid: true, value: trimmed, error: null };
  }
}

/** Placeholder text hinting at the expected format for a column's input. */
export function placeholderFor(column: ColumnDefinition): string {
  switch (column.type) {
    case "number":
      return "0";
    case "boolean":
      return "true / false";
    case "date":
      return "YYYY-MM-DD";
    case "datetime":
      return "YYYY-MM-DDTHH:mm:ss";
    case "json":
      return '{"key": "value"}';
    default:
      return column.nullable ? "NULL" : "";
  }
}
