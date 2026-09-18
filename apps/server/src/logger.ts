import path from "node:path";
import pino from "pino";

/**
 * Single shared logger for the whole process — Fastify uses it for request
 * logs (see index.ts's `loggerInstance`), and every other module (stores,
 * drivers glue, background pollers) imports it instead of `console.error`,
 * so every error ends up in the same place: a daily-rotating file under
 * `logs/`, the Node/pino equivalent of Laravel's daily log driver.
 *
 * Rotated files are named `app.<date>.<n>.log` (e.g. `app.2026-09-07.1.log`)
 * — see pino-roll's README for the exact naming rule.
 */
const LOG_DIR = path.resolve(process.cwd(), "logs");
const isProd = process.env.NODE_ENV === "production";

const targets: pino.TransportTargetOptions[] = [
    {
        target: "pino-roll",
        options: { file: path.join(LOG_DIR, "app"), frequency: "daily", dateFormat: "yyyy-MM-dd", mkdir: true, extension: ".log" },
        level: "info",
    },
    // Console output too: pretty in dev, structured JSON in prod (so a
    // container's own log collector still sees everything even if the
    // `logs/` volume isn't persisted).
    isProd
        ? { target: "pino/file", options: { destination: 1 }, level: "info" }
        : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" }, level: "info" },
];

/**
 * Embed links carry their token in the query string — an iframe cannot send a
 * header, so there is nowhere else to put it. That means every request log
 * line for a public dashboard would otherwise persist a working credential to
 * disk, where it outlives the link itself. Strip it before anything is
 * written; the rest of the URL is what makes the line useful anyway.
 */
function redactUrl(url: string): string {
    const q = url.indexOf("?");
    if (q === -1) return url;
    const params = new URLSearchParams(url.slice(q + 1));
    if (!params.has("token")) return url;
    params.set("token", "REDACTED");
    return `${url.slice(0, q)}?${params.toString()}`;
}

export const logger = pino(
    {
        level: process.env.LOG_LEVEL ?? "info",
        serializers: {
            req(req: { method: string; url: string; headers: Record<string, unknown>; remoteAddress?: string }) {
                return { method: req.method, url: redactUrl(req.url), remoteAddress: req.remoteAddress };
            },
        },
    },
    pino.transport({ targets })
);
