/**
 * Sends a frontend error to the backend so it lands in the same daily log
 * file as server-side errors, instead of only ever being visible in one
 * user's browser console. Fire-and-forget and never throws itself — a
 * failure to report an error must never become a second error.
 */
export function reportClientError(message: string, extra?: { stack?: string; componentStack?: string }) {
    fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, url: window.location.href, ...extra }),
    }).catch(() => { });
}

let installed = false;

/** Call once at startup — catches errors React's own ErrorBoundary can't (outside render: timers, event handlers, promise rejections). */
export function installGlobalErrorReporting() {
    if (installed) return;
    installed = true;

    window.addEventListener("error", (event) => {
        reportClientError(event.message, { stack: event.error?.stack });
    });

    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        reportClientError(`Unhandled promise rejection: ${message}`, { stack: reason?.stack });
    });
}
