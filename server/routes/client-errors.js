/**
 * Lets the frontend hand its own errors (render crashes, window.onerror,
 * unhandled promise rejections, react-query failures) to the backend so
 * they land in the same daily log file as server-side errors, instead of
 * only ever being visible in one user's browser console.
 */
export async function clientErrorRoutes(app) {
    app.post("/api/client-errors", async (req, reply) => {
        const body = req.body;
        if (!body || typeof body.message !== "string") {
            reply.code(400);
            return { error: 'Missing "message" in request body' };
        }
        app.log.error({ source: "frontend", url: body.url, stack: body.stack, componentStack: body.componentStack }, body.message);
        reply.code(204);
    });
}
//# sourceMappingURL=client-errors.js.map