import type { FastifyInstance } from "fastify";
/**
 * No session/auth beyond the share token. This is the trust boundary: the
 * public routes that call this only ever replay a widget's PRE-SAVED query
 * (built and validated server-side when the widget was created) — they
 * accept no free-form SQL, table, or column input from the caller. An
 * embed link can only show what its creator configured, nothing else.
 */
export declare function authorizeEmbed(dashboardId: string, token: string | undefined): {
    ok: true;
} | {
    ok: false;
    status: number;
    error: string;
};
export declare function dashboardRoutes(app: FastifyInstance): Promise<void>;
