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
const targets = [
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
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }, pino.transport({ targets }));
//# sourceMappingURL=logger.js.map