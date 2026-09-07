import type { FastifyInstance } from "fastify";

interface ClientErrorReport {
    message: string;
    stack?: string;
    url?: string;
    componentStack?: string; // present for React render errors caught by the ErrorBoundary
}

/**
 * Lets the frontend hand its own errors (render crashes, window.onerror,
 * unhandled promise rejections, react-query failures) to the backend so
 * they land in the same daily log file as server-side errors, instead of
 * only ever being visible in one user's browser console.
 */
export async function clientErrorRoutes(app: FastifyInstance) {
    app.post("/api/client-errors", async (req, reply) => {
        const body = req.body as Partial<ClientErrorReport> | undefined;
        if (!body || typeof body.message !== "string") {
            reply.code(400);
            return { error: 'Missing "message" in request body' };
        }
        app.log.error(
            { source: "frontend", url: body.url, stack: body.stack, componentStack: body.componentStack },
            body.message
        );
        reply.code(204);
    });
}
