import {
    BarChart,
    Bar,
    LineChart,
    Line,
    AreaChart,
    Area,
    ScatterChart,
    Scatter,
    PieChart,
    Pie,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";
import type { HighlightRule } from "./api.js";
import { registerChartType, getChartType, type ChartTypeProps } from "./chartTypes.js";

const TOOLTIP = {
    contentStyle: { background: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", fontSize: 12 },
} as const;

/**
 * Recharts' default hover cursor is a solid #ccc block sized to the whole
 * category band, which on this theme paints a light grey slab across the
 * chart. A hint of the accent colour reads as "this is the hovered bar"
 * without covering it; line and area charts get a thin guide line instead,
 * and a pie slice highlights itself, so it gets no cursor at all.
 */
const BAND_CURSOR = { fill: "hsl(200 90% 55%)", fillOpacity: 0.1 } as const;
const CROSSHAIR_CURSOR = { stroke: "hsl(240 4% 35%)", strokeWidth: 1 } as const;

const COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#fb923c"];

function toNumber(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** First matching rule's color for this cell, or undefined. A rule with no `column` matches any numeric cell. */
function highlightColor(value: unknown, column: string, rules?: HighlightRule[]): string | undefined {
    if (!rules?.length) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    for (const r of rules) {
        if (r.column && r.column !== column) continue;
        const hit =
            r.operator === "gt"
                ? n > r.value
                : r.operator === "gte"
                  ? n >= r.value
                  : r.operator === "lt"
                    ? n < r.value
                    : r.operator === "lte"
                      ? n <= r.value
                      : n === r.value;
        if (hit) return r.color;
    }
    return undefined;
}

function NumberCard({ data, highlightRules }: ChartTypeProps) {
    const value = data.rows[0]?.[data.yKey];
    const color = highlightColor(value, data.yKey || "y", highlightRules);
    return (
        <div className="flex h-full flex-col items-center justify-center">
            <div
                className="rounded-md px-4 py-2 text-3xl font-semibold tabular-nums"
                style={color ? { backgroundColor: color } : undefined}
            >
                {toNumber(value).toLocaleString()}
            </div>
        </div>
    );
}

/** Row × column pivot rendering, shared by "table" (when x2Key is set) and the standalone "pivot" chart type. */
function PivotGrid({ data, highlightRules, onDataPointClick }: ChartTypeProps) {
    const rowKeys: string[] = [];
    const colKeys: string[] = [];
    const cells = new Map<string, unknown>();
    for (const row of data.rows) {
        const rk = String(row[data.xKey] ?? "");
        const ck = String(row[data.x2Key!] ?? "");
        if (!rowKeys.includes(rk)) rowKeys.push(rk);
        if (!colKeys.includes(ck)) colKeys.push(ck);
        cells.set(`${rk} ${ck}`, row[data.yKey]);
    }
    return (
        <div className="h-full overflow-auto">
            <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                    <tr>
                        <th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground" />
                        {colKeys.map((ck) => (
                            <th
                                key={ck}
                                className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground"
                            >
                                {ck}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rowKeys.map((rk) => (
                        <tr
                            key={rk}
                            className={`hover:bg-muted/40 ${onDataPointClick ? "cursor-pointer" : ""}`}
                            onClick={() => onDataPointClick?.(rk)}
                        >
                            <td className="border-b border-border/40 px-2 py-1 font-medium">{rk}</td>
                            {colKeys.map((ck) => {
                                const value = cells.get(`${rk} ${ck}`);
                                const color = highlightColor(value, "y", highlightRules);
                                return (
                                    <td
                                        key={ck}
                                        className="border-b border-border/40 px-2 py-1 font-mono"
                                        style={color ? { backgroundColor: color } : undefined}
                                    >
                                        {value === undefined ? "" : String(value)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function TableCard(props: ChartTypeProps) {
    const { data, highlightRules, onDataPointClick } = props;
    // Row × column pivot (Salesforce-style matrix report): rows are xKey values, columns are the distinct x2Key values.
    if (data.x2Key) return <PivotGrid {...props} />;

    const cols = data.rows.length ? Object.keys(data.rows[0]) : [];
    // A raw (ungrouped) table has no xKey to click through to a dashboard
    // param/drill target — only a grouped summary (xKey set) is clickable.
    const clickable = !!data.xKey && !!onDataPointClick;
    return (
        <div className="h-full overflow-auto">
            <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                    <tr>
                        {cols.map((c) => (
                            <th
                                key={c}
                                className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground"
                            >
                                {c}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.rows.map((row, i) => (
                        <tr
                            key={i}
                            className={`hover:bg-muted/40 ${clickable ? "cursor-pointer" : ""}`}
                            onClick={clickable ? () => onDataPointClick!(row[data.xKey]) : undefined}
                        >
                            {cols.map((c) => {
                                const color = highlightColor(row[c], c, highlightRules);
                                return (
                                    <td
                                        key={c}
                                        className="border-b border-border/40 px-2 py-1 font-mono"
                                        style={color ? { backgroundColor: color } : undefined}
                                    >
                                        {String(row[c] ?? "")}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/**
 * "pivot" — added purely through the chart-type registry (see chartTypes.ts
 * and the bottom of this file) to prove the registry actually works: it is
 * not a branch of any switch, it's a second `registerChartType` call.
 * Data-wise it's the same row × column grouping "table" already produces
 * when xField2 is set (see chart-query.ts) — this type just always renders
 * as that grid, without needing xField2 to be set to get it.
 */
function PivotCard(props: ChartTypeProps) {
    if (!props.data.x2Key) {
        return (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                Set both a row and column grouping on this widget to render a pivot table.
            </div>
        );
    }
    return <PivotGrid {...props} />;
}

function ScatterCard({ data, onDataPointClick }: ChartTypeProps) {
    // Unlike bar/line/area/pie, a scatter plot's x-axis is a raw numeric value, not a category.
    const points = data.rows.map((r) => ({ x: toNumber(r[data.xKey]), y: toNumber(r[data.yKey]) }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
                <XAxis type="number" dataKey="x" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <YAxis type="number" dataKey="y" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <Tooltip {...TOOLTIP} cursor={CROSSHAIR_CURSOR} />
                <Scatter
                    data={points}
                    fill="#38bdf8"
                    cursor={onDataPointClick ? "pointer" : undefined}
                    onClick={(point: any) => onDataPointClick?.(point?.payload?.x ?? point?.x)}
                />
            </ScatterChart>
        </ResponsiveContainer>
    );
}

function PieCard({ data, onDataPointClick }: ChartTypeProps) {
    // `x` is stringified for the chart label ("" for a null group, e.g. a
    // blank picklist value); `xRaw` keeps the real value so drill-to-detail
    // filters on the actual column value (and null uses IS NULL) instead of
    // on the display string.
    const chartData = data.rows.map((r) => ({
        x: String(r[data.xKey] ?? ""),
        xRaw: r[data.xKey],
        y: toNumber(r[data.yKey]),
    }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <PieChart>
                <Pie
                    data={chartData}
                    dataKey="y"
                    nameKey="x"
                    cx="50%"
                    cy="50%"
                    outerRadius="75%"
                    label
                    cursor={onDataPointClick ? "pointer" : undefined}
                    onClick={(entry: any) => onDataPointClick?.(entry?.payload ? entry.payload.xRaw : entry?.name)}
                >
                    {chartData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                </Pie>
                <Tooltip {...TOOLTIP} cursor={false} />
            </PieChart>
        </ResponsiveContainer>
    );
}

function LineCard({ data, onDataPointClick }: ChartTypeProps) {
    const chartData = data.rows.map((r) => ({
        x: String(r[data.xKey] ?? ""),
        xRaw: r[data.xKey],
        y: toNumber(r[data.yKey]),
    }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart
                data={chartData}
                onClick={(e: any) => {
                    if (e?.activeLabel === undefined) return;
                    const point = e.activePayload?.[0]?.payload;
                    onDataPointClick?.(point ? point.xRaw : e.activeLabel);
                }}
                style={onDataPointClick ? { cursor: "pointer" } : undefined}
            >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
                <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <Tooltip {...TOOLTIP} cursor={CROSSHAIR_CURSOR} />
                <Line type="monotone" dataKey="y" stroke="#38bdf8" strokeWidth={2} dot={false} />
            </LineChart>
        </ResponsiveContainer>
    );
}

function AreaCard({ data, onDataPointClick }: ChartTypeProps) {
    const chartData = data.rows.map((r) => ({
        x: String(r[data.xKey] ?? ""),
        xRaw: r[data.xKey],
        y: toNumber(r[data.yKey]),
    }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart
                data={chartData}
                onClick={(e: any) => {
                    if (e?.activeLabel === undefined) return;
                    const point = e.activePayload?.[0]?.payload;
                    onDataPointClick?.(point ? point.xRaw : e.activeLabel);
                }}
                style={onDataPointClick ? { cursor: "pointer" } : undefined}
            >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
                <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <Tooltip {...TOOLTIP} cursor={CROSSHAIR_CURSOR} />
                <Area type="monotone" dataKey="y" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.3} />
            </AreaChart>
        </ResponsiveContainer>
    );
}

function BarCard({ data, onDataPointClick }: ChartTypeProps) {
    const chartData = data.rows.map((r) => ({
        x: String(r[data.xKey] ?? ""),
        xRaw: r[data.xKey],
        y: toNumber(r[data.yKey]),
    }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
                <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
                <Tooltip {...TOOLTIP} cursor={BAND_CURSOR} />
                <Bar
                    dataKey="y"
                    fill="#38bdf8"
                    radius={[4, 4, 0, 0]}
                    cursor={onDataPointClick ? "pointer" : undefined}
                    onClick={(entry: any) => onDataPointClick?.(entry?.payload ? entry.payload.xRaw : entry?.x)}
                />
            </BarChart>
        </ResponsiveContainer>
    );
}

// Built-in chart types, registered through the same `registerChartType` a
// third-party addition would use — this is what makes the addition of
// "pivot" below a proof of the registry rather than a special case. Doing
// this at module load keeps the set of built-ins a zero-behavior-change
// refactor of what used to be a fixed switch statement.
registerChartType("number", { label: "Number", shape: "number", component: NumberCard });
registerChartType("table", { label: "Table", shape: "table", component: TableCard });
registerChartType("scatter", { label: "Scatter", shape: "raw", component: ScatterCard });
registerChartType("pie", { label: "Pie", shape: "grouped", component: PieCard });
registerChartType("line", { label: "Line", shape: "grouped", component: LineCard });
registerChartType("area", { label: "Area", shape: "grouped", component: AreaCard });
registerChartType("bar", { label: "Bar", shape: "grouped", component: BarCard });
// pivot queries exactly like "table" (chart-shapes.ts maps both to the same
// shape) — this is the one genuinely new chart type added through the
// registry (B4), no edits to any switch/if-chain were needed to add it.
registerChartType("pivot", { label: "Pivot", shape: "table", component: PivotCard });

interface Props extends ChartTypeProps {
    chartType: string;
    title?: string;
}

export function ChartRenderer({ chartType, ...rest }: Props) {
    // A registry lookup of an already-defined component, not a component
    // literal created fresh each render — react-hooks/static-components can't
    // tell the two apart and flags this as the latter; irrelevant here anyway
    // since this project doesn't run the React Compiler (see
    // react-hooks/incompatible-library above).
    const Component = getChartType(chartType);
    if (!Component) {
        return (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                Unknown chart type &quot;{chartType}&quot;
            </div>
        );
    }
    // eslint-disable-next-line react-hooks/static-components
    return <Component {...rest} />;
}
