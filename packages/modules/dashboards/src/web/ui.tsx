import * as React from "react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Minimal UI primitives, duplicated (not imported) from the host app's own
 * `@/components/ui/*` so this package stays a self-contained peer of
 * `react`, with no import reaching back into the app hosting it — same
 * boundary record-create's NewRowDialog established for its own dialog.
 */

// ponytail: a plain join instead of pulling in clsx/tailwind-merge as new
// dependencies — nothing here passes conflicting utility classes that need
// tailwind-merge's de-duplication, only additive ones.
function cx(...parts: Array<string | false | null | undefined>): string {
    return parts.filter(Boolean).join(" ");
}

type Variant = "default" | "secondary" | "ghost" | "destructive";
type Size = "default" | "sm" | "icon";

const variantClasses: Record<Variant, string> = {
    default: "bg-accent text-accent-foreground hover:bg-accent/90",
    secondary: "bg-muted text-foreground hover:bg-muted/70",
    ghost: "hover:bg-muted text-foreground",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

const sizeClasses: Record<Size, string> = {
    default: "h-9 px-4 text-sm",
    sm: "h-8 px-3 text-xs",
    icon: "h-8 w-8",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "default", size = "default", ...props }, ref) => (
        <button
            ref={ref}
            className={cx(
                "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                variantClasses[variant],
                sizeClasses[size],
                className
            )}
            {...props}
        />
    )
);
Button.displayName = "Button";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => (
        <input
            ref={ref}
            className={cx(
                "h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                className
            )}
            {...props}
        />
    )
);
Input.displayName = "Input";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cx("rounded-lg border border-border bg-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cx("border-b border-border px-4 py-3", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cx("p-4", className)} {...props} />;
}

interface ModalProps {
    onClose: () => void;
    children: ReactNode;
    labelledBy?: string;
    className?: string;
}

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab focus inside itself, closes on Escape, restores focus to
 * whatever triggered it on close, and is announced correctly to screen
 * readers via role="dialog" + aria-modal.
 */
export function Modal({ onClose, children, labelledBy, className }: ModalProps) {
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
                (el) => el.offsetParent !== null // skip hidden elements
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
            className="fixed inset-0 z-30 overflow-y-auto bg-black/60"
            onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
            {/* min-h-full (not h-full) + items-center: centers content that fits the
                viewport, but — unlike a fixed-height flex centerer — still lets the
                overlay's own overflow-y-auto scroll to reach content that doesn't. */}
            <div className="flex min-h-full items-center justify-center p-4">
                <div
                    ref={containerRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={labelledBy}
                    tabIndex={-1}
                    className={className}
                >
                    {children}
                </div>
            </div>
        </div>
    );
}

/**
 * Module-level toast queue + emitter (not React context) — every async action
 * in this module (widget/dashboard mutations) that previously failed silently
 * calls `toast.error(...)` from wherever it already catches, with no provider
 * to thread through. `<Toaster />` is mounted once per view root and just
 * subscribes.
 */
interface ToastMessage {
    id: number;
    text: string;
    variant: "error" | "success";
}
let toastQueue: ToastMessage[] = [];
let toastListeners: Array<(queue: ToastMessage[]) => void> = [];
let nextToastId = 0;

function emitToasts() {
    for (const listener of toastListeners) listener(toastQueue);
}

function dismissToast(id: number) {
    toastQueue = toastQueue.filter((t) => t.id !== id);
    emitToasts();
}

function pushToast(text: string, variant: ToastMessage["variant"]) {
    const id = nextToastId++;
    toastQueue = [...toastQueue, { id, text, variant }];
    emitToasts();
    setTimeout(() => dismissToast(id), variant === "error" ? 6000 : 3000);
}

export const toast = {
    error: (text: string) => pushToast(text, "error"),
    success: (text: string) => pushToast(text, "success"),
};

export function Toaster() {
    const [queue, setQueue] = useState(toastQueue);
    useEffect(() => {
        toastListeners.push(setQueue);
        return () => {
            toastListeners = toastListeners.filter((l) => l !== setQueue);
        };
    }, []);

    if (queue.length === 0) return null;
    return (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            {queue.map((t) => (
                <div
                    key={t.id}
                    role="alert"
                    className={cx(
                        "flex max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg",
                        t.variant === "error"
                            ? "border-destructive bg-destructive/10 text-destructive"
                            : "border-border bg-card text-foreground"
                    )}
                >
                    <span className="flex-1">{t.text}</span>
                    <button onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100">
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}
