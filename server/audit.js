import path from "node:path";
import pino from "pino";
/**
 * Append-only audit trail, separate from the application log.
 *
 * This app exists to read and edit production data, so "what did it touch,
 * when, from where" is the one record an operator cannot reconstruct after
 * the fact. It is deliberately its own stream rather than a log level: the
 * application log is noisy, rotated for volume, and something an operator may
 * reasonably drop — an audit trail is neither.
 *
 * ponytail: there is no identity to attribute actions to yet (this release
 * has no users), so entries record the source address and agent instead. Add
 * an `actor` field here the moment authentication lands — everything else
 * about the format is already shaped for it.
 */
const AUDIT_DIR = path.resolve(process.cwd(), "logs");
const auditLogger = pino({ level: "info", base: undefined }, pino.transport({
    target: "pino-roll",
    options: {
        file: path.join(AUDIT_DIR, "audit"),
        frequency: "daily",
        dateFormat: "yyyy-MM-dd",
        mkdir: true,
        extension: ".log",
    },
}));
/**
 * Whether to record the *values* moving through the app, not just which rows
 * and columns were touched. Off by default: an audit trail that copies every
 * edited cell becomes a second, unguarded store of the same sensitive data it
 * is auditing. Turn it on where the trail itself is protected and full
 * before/after values are required.
 */
const RECORD_VALUES = process.env.DB_VIEWER_AUDIT_VALUES === "true";
/** Replaces values with a type tag so the shape of a change is auditable without copying its contents. */
export function summarizeValue(value) {
    if (RECORD_VALUES)
        return value;
    if (value === null)
        return "<null>";
    if (Array.isArray(value))
        return `<array:${value.length}>`;
    switch (typeof value) {
        case "undefined":
            return undefined;
        case "object":
            return `<object:${Object.keys(value).join(",")}>`;
        case "string":
            return `<string:${value.length}>`;
        default:
            return `<${typeof value}>`;
    }
}
export function audit(entry) {
    auditLogger.info(entry);
}
//# sourceMappingURL=audit.js.map