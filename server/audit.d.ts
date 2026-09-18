export interface AuditEntry {
    action: string;
    method: string;
    route: string;
    status: number;
    durationMs: number;
    ip?: string;
    userAgent?: string;
    connectionId?: string;
    table?: string;
    detail?: Record<string, unknown>;
}
/** Replaces values with a type tag so the shape of a change is auditable without copying its contents. */
export declare function summarizeValue(value: unknown): unknown;
export declare function audit(entry: AuditEntry): void;
