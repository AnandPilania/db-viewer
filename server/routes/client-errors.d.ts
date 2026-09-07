import type { FastifyInstance } from "fastify";
/**
 * Lets the frontend hand its own errors (render crashes, window.onerror,
 * unhandled promise rejections, react-query failures) to the backend so
 * they land in the same daily log file as server-side errors, instead of
 * only ever being visible in one user's browser console.
 */
export declare function clientErrorRoutes(app: FastifyInstance): Promise<void>;
