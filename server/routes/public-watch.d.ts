import type { FastifyInstance } from "fastify";
/**
 * Public equivalent of /ws/connections/:id/tables/:table/watch — but this
 * one is reachable from an embedded page on any external site, so it must
 * not leak the same information. It:
 *  - requires the dashboard's share token, same as the other public routes
 *  - never sends the raw row payload, only a content-free "changed" ping —
 *    the client already has a safe, pre-scoped way to fetch the actual
 *    data (the public widget-data endpoint), so there's no reason to also
 *    push raw row contents over this channel
 *  - never exposes which connectionId/table the widget reads from; that
 *    stays server-side
 */
export declare function publicWatchRoutes(app: FastifyInstance): Promise<void>;
