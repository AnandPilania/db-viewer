import { useEffect, useRef, useState, type ReactNode } from "react";
import { validateValue, placeholderFor, checkConstraints } from "@pilaniaanand/driver-interface";
import { runCustomValidators } from "./registerFieldValidator.js";
import type { GridActionProps } from "./types.js";

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Minimal standalone modal: traps Tab focus, closes on Escape, restores
 * focus on close. Duplicated (rather than imported) from the host app's own
 * Modal so this package stays a self-contained peer of `react`, with no
 * import reaching back into the app hosting it.
 */
function Modal({ onClose, labelledBy, children }: { onClose: () => void; labelledBy: string; children: ReactNode }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const previouslyFocused = useRef<HTMLElement | null>(null);

    useEffect(() => {
        previouslyFocused.current = document.activeElement as HTMLElement | null;
        const container = containerRef.current;
        const focusables = container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        (focusables?.[0] ?? container)?.focus();

        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
                return;
            }
            if (e.key !== "Tab" || !container) return;
            const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
                (el) => el.offsetParent !== null
            );
            if (nodes.length === 0) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }

        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            previouslyFocused.current?.focus?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            className="fixed inset-0 z-30 flex items-center justify-center bg-black/60"
            onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
            <div
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                tabIndex={-1}
                className="w-full max-w-md rounded-lg border border-border bg-card"
            >
                {children}
            </div>
        </div>
    );
}

interface FieldError {
    column: string;
    message: string;
}

type Props = Pick<GridActionProps, "connectionId" | "table" | "columns" | "onRowCreated" | "close">;

export function NewRowDialog({ connectionId, table, columns, onRowCreated, close }: Props) {
    const editableColumns = columns.filter((c) => !(c.isPrimaryKey && c.defaultValue));
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit() {
        const values: Record<string, unknown> = {};
        const nextErrors: Record<string, string> = {};

        for (const col of editableColumns) {
            const raw = drafts[col.name] ?? "";
            const result = validateValue(raw, col);
            if (!result.valid) {
                nextErrors[col.name] = result.error!;
                continue;
            }
            if (result.value !== undefined) {
                const constraintError = checkConstraints(result.value, col) ?? runCustomValidators(col, raw, drafts);
                if (constraintError) {
                    nextErrors[col.name] = constraintError;
                    continue;
                }
                values[col.name] = result.value;
            }
        }

        if (Object.keys(nextErrors).length > 0) {
            setErrors(nextErrors);
            return;
        }

        setSaving(true);
        setSubmitError(null);
        setErrors({});
        try {
            const res = await fetch(
                `/api/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(table)}/records`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ values }),
                }
            );
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                const fieldErrors: FieldError[] | undefined = body?.fieldErrors;
                if (fieldErrors?.length) {
                    setErrors(Object.fromEntries(fieldErrors.map((fe) => [fe.column, fe.message])));
                } else {
                    setSubmitError(body?.error ?? `Request failed: ${res.status}`);
                }
                return;
            }
            onRowCreated(body);
            close();
        } catch (err) {
            setSubmitError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal onClose={close} labelledBy="new-row-title">
            <div className="border-b border-border px-4 py-3">
                <span id="new-row-title" className="text-sm font-medium">
                    New row in {table}
                </span>
            </div>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
                {editableColumns.map((col) => (
                    <div key={col.name} className="space-y-1">
                        <label
                            htmlFor={`new-row-${col.name}`}
                            className="flex items-center gap-1 text-xs text-muted-foreground"
                        >
                            {col.name}
                            <span className="text-[10px] text-muted-foreground/60">
                                {col.nativeType || col.type}
                                {!col.nullable && !col.defaultValue && " · required"}
                            </span>
                        </label>
                        <input
                            id={`new-row-${col.name}`}
                            value={drafts[col.name] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [col.name]: e.target.value }))}
                            placeholder={placeholderFor(col)}
                            aria-invalid={!!errors[col.name]}
                            aria-describedby={errors[col.name] ? `new-row-${col.name}-error` : undefined}
                            className={`h-9 w-full rounded-md border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                errors[col.name] ? "border-destructive" : "border-input"
                            }`}
                        />
                        {col.checkExpression && (
                            <div className="text-[11px] text-muted-foreground/70">CHECK {col.checkExpression}</div>
                        )}
                        {errors[col.name] && (
                            <div id={`new-row-${col.name}-error`} className="text-[11px] text-destructive">
                                {errors[col.name]}
                            </div>
                        )}
                    </div>
                ))}

                {submitError && (
                    <div role="alert" className="text-xs text-destructive">
                        {submitError}
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                    <button
                        className="inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                        onClick={close}
                        disabled={saving}
                    >
                        Cancel
                    </button>
                    <button
                        className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
                        onClick={handleSubmit}
                        disabled={saving}
                    >
                        {saving ? "Creating…" : "Create row"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
