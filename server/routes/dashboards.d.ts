import type { FastifyInstance } from "fastify";
export declare function authorizeEmbed(dashboardId: string, token: string | undefined): {
    ok: true;
} | {
    ok: false;
    status: number;
    error: string;
};
export declare function dashboardRoutes(app: FastifyInstance): Promise<void>;
