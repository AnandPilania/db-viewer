import { describe, expect, it } from "vitest";
import { fetchWidgetData } from "../apps/server/src/chart-query.js";
import type { Widget } from "../apps/server/src/models.js";
import type { ConnectionConfig, DriverConnection, QuerySpec } from "@pilaniaanand/driver-interface";

/**
 * A connection that runs nothing and just records the query it was handed.
 *
 * The thing worth testing here is the SQL text itself — operators, calendar
 * bucketing, ordering and the row cap all end up as string fragments, and a
 * mistake in any of them is either a wrong chart or (for the pieces that are
 * concatenated rather than bound) a hole. Every widget below gets a distinct
 * definition so the query cache in chart-query can never serve one test's
 * result to another.
 */
function fakeConn(id: string): DriverConnection & { last: QuerySpec | null } {
    const conn = {
        id,
        last: null as QuerySpec | null,
        listTables: async () => [
            {
                name: "orders",
                kind: "table" as const,
                columns: ["status", "total", "created_at", "region"].map((name) => ({
                    name,
                    type: "string" as const,
                    nullable: true,
                    isPrimaryKey: false,
                    isForeignKey: false,
                })),
            },
        ],
        async *streamQuery({ query }: { query: QuerySpec }) {
            conn.last = query;
            yield { rows: [], columns: [] };
        },
    };
    return conn as unknown as DriverConnection & { last: QuerySpec | null };
}

const pg = { driver: "postgres" } as ConnectionConfig;

const base: Widget = {
    id: "w1",
    title: "Orders",
    connectionId: "c1",
    table: "orders",
    chartType: "bar",
    xField: "status",
    aggregation: "count",
    createdAt: "2026-01-01T00:00:00.000Z",
};

async function sqlFor(widget: Partial<Widget>, connId: string): Promise<{ sql: string; params: unknown[] }> {
    const conn = fakeConn(connId);
    await fetchWidgetData(conn, pg, { ...base, ...widget });
    const spec = conn.last as Extract<QuerySpec, { language: "sql" }>;
    return { sql: spec.sql, params: spec.params ?? [] };
}

describe("widget chart queries", () => {
    it("binds comparison filter values instead of concatenating them", async () => {
        const { sql, params } = await sqlFor(
            { filters: [{ column: "total", op: ">=", value: "100" }, { column: "region", op: "like", value: "%east%" }] },
            "c-ops"
        );
        expect(sql).toContain(`"total" >= $1`);
        expect(sql).toContain(`"region" LIKE $2`);
        expect(params).toEqual(["100", "%east%"]);
    });

    it("expands an `in` filter to one bound placeholder per value", async () => {
        const { sql, params } = await sqlFor({ filters: [{ column: "status", op: "in", value: "new, paid ,shipped" }] }, "c-in");
        expect(sql).toContain(`"status" IN ($1, $2, $3)`);
        expect(params).toEqual(["new", "paid", "shipped"]);
    });

    it("emits null checks with no value at all", async () => {
        const { sql, params } = await sqlFor({ filters: [{ column: "region", op: "is null", value: "" }] }, "c-null");
        expect(sql).toContain(`"region" IS NULL`);
        expect(params).toEqual([]);
    });

    it("rejects an operator that never passed validation", async () => {
        await expect(
            sqlFor({ filters: [{ column: "status", op: "; DROP TABLE orders --" as never, value: "x" }] }, "c-bad")
        ).rejects.toThrow(/Unsupported filter operator/);
    });

    it("buckets a date axis and orders along it rather than by value", async () => {
        const { sql } = await sqlFor({ xField: "created_at", xBucket: "month" }, "c-bucket");
        expect(sql).toContain(`date_trunc('month', "created_at")`);
        expect(sql).toContain(`ORDER BY date_trunc('month', "created_at") ASC`);
    });

    it("defaults an unbucketed grouped chart to a top-N by value", async () => {
        const { sql } = await sqlFor({}, "c-default");
        expect(sql).toContain("ORDER BY y DESC");
        expect(sql).toContain("LIMIT 50");
    });

    it("honours an explicit sort and row cap, and clamps an absurd one", async () => {
        const { sql } = await sqlFor({ sortBy: "label", sortDir: "asc", limit: 7 }, "c-sort");
        expect(sql).toContain(`ORDER BY "status" ASC`);
        expect(sql).toContain("LIMIT 7");

        const { sql: clamped } = await sqlFor({ limit: 999_999 }, "c-clamp");
        expect(clamped).toContain("LIMIT 1000");
    });

    it("coalesces concurrent requests for the same widget into one query", async () => {
        const conn = fakeConn("c-cache");
        let queries = 0;
        const original = conn.streamQuery.bind(conn);
        conn.streamQuery = ((opts: { query: QuerySpec }) => {
            queries++;
            return original(opts);
        }) as typeof conn.streamQuery;

        const widget = { ...base, title: "Coalesced" };
        await Promise.all([fetchWidgetData(conn, pg, widget), fetchWidgetData(conn, pg, widget)]);
        expect(queries).toBe(1);
    });
});
