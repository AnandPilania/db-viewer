import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { coreApi } from "./api.js";
import {
    dashboardApi,
    placeholderName,
    type Widget,
    type HighlightRule,
    type WidgetFilter,
    type FilterOperator,
    type TimeBucket,
    type DashboardParameter,
} from "./api.js";
import { Button, Input, Card, CardContent, CardHeader, Modal } from "./ui.js";
import { listChartTypes, type ChartShape } from "./chartTypes.js";

interface Props {
    onCancel: () => void;
    /** Awaited from inside the submit handler's try/catch, so a rejection (e.g. the
     * dashboard-layout update after create) surfaces here as a form error instead
     * of an unhandled rejection with the modal already closed. */
    onSaved: (widget: Widget) => void | Promise<void>;
    /** When provided, the form edits this widget (pre-filled, submits via PATCH) instead of creating a new one. */
    editingWidget?: Widget;
    /** The current dashboard's declared parameters, if any — offered as a filter-value source alongside a literal. */
    dashboardParameters?: DashboardParameter[];
}

// Read once at module load — same lifetime as the registry itself (built-ins
// register at import time in ChartRenderer.tsx; a host app registers its own
// before rendering anything). Not derived per-render since the registry
// doesn't change after startup.
const CHART_TYPE_DEFS = listChartTypes();
const CHART_SHAPES = new Map<string, ChartShape>(CHART_TYPE_DEFS.map(([key, def]) => [key, def.shape]));
const AGGREGATIONS: Widget["aggregation"][] = ["count", "sum", "avg", "min", "max"];
const TIME_BUCKETS: TimeBucket[] = ["day", "week", "month", "quarter", "year"];
const FILTER_OPS: { op: FilterOperator; label: string }[] = [
    { op: "=", label: "=" },
    { op: "!=", label: "≠" },
    { op: ">", label: ">" },
    { op: ">=", label: "≥" },
    { op: "<", label: "<" },
    { op: "<=", label: "≤" },
    { op: "like", label: "like" },
    { op: "in", label: "in" },
    { op: "is null", label: "is null" },
    { op: "is not null", label: "not null" },
];
/** The two operators that compare against nothing — their value input is hidden. */
const NULL_OPS = new Set<FilterOperator>(["is null", "is not null"]);
/** Chart types whose x-axis is a grouped aggregation, and so can be bucketed, re-sorted, and top-N capped. */
const GROUPED_TYPES = new Set(
    CHART_TYPE_DEFS.filter(([, def]) => def.shape === "grouped" || def.shape === "table").map(([key]) => key)
);
/** Chart types that render as a row × column grid — "table"-shaped only pivots when xField2 is also set, "pivot" always does (it's still just "table" shape server-side). */
const PIVOTABLE_TYPES = new Set(CHART_TYPE_DEFS.filter(([, def]) => def.shape === "table").map(([key]) => key));

export function WidgetForm({ onCancel, onSaved, editingWidget, dashboardParameters }: Props) {
    const { data: connections, isLoading: connectionsLoading } = useQuery({
        queryKey: ["connections"],
        queryFn: coreApi.listConnections,
    });
    const [kind, setKind] = useState<"chart" | "text">(editingWidget?.kind === "text" ? "text" : "chart");
    const [content, setContent] = useState(editingWidget?.content ?? "");
    const [clickParameter, setClickParameter] = useState(editingWidget?.clickParameter ?? "");
    const [drillEnabled, setDrillEnabled] = useState(!!editingWidget?.drillEnabled);
    const [connectionId, setConnectionId] = useState(editingWidget?.connectionId ?? "");
    const [table, setTable] = useState(editingWidget?.table ?? "");
    const [title, setTitle] = useState(editingWidget?.title ?? "");
    const [chartType, setChartType] = useState<Widget["chartType"]>(editingWidget?.chartType ?? "bar");
    const [xField, setXField] = useState(editingWidget?.xField ?? "");
    const [yField, setYField] = useState(editingWidget?.yField ?? "");
    const [xField2, setXField2] = useState(editingWidget?.xField2 ?? "");
    const [aggregation, setAggregation] = useState<Widget["aggregation"]>(editingWidget?.aggregation ?? "count");
    const [filters, setFilters] = useState<WidgetFilter[]>(editingWidget?.filters ?? []);
    const [xBucket, setXBucket] = useState<TimeBucket | "">(editingWidget?.xBucket ?? "");
    const [limit, setLimit] = useState(editingWidget?.limit ? String(editingWidget.limit) : "");
    const [sortBy, setSortBy] = useState<"" | "value" | "label">(editingWidget?.sortBy ?? "");
    const [sortDir, setSortDir] = useState<"" | "asc" | "desc">(editingWidget?.sortDir ?? "");
    const [highlightRules, setHighlightRules] = useState<HighlightRule[]>(editingWidget?.highlightRules ?? []);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const { data: tables, isLoading: tablesLoading } = useQuery({
        queryKey: ["tables", connectionId],
        queryFn: () => coreApi.listTables(connectionId),
        enabled: !!connectionId,
    });

    const columns = tables?.find((t) => t.name === table)?.columns ?? [];
    const selectedDriver = connections?.find((c) => c.id === connectionId)?.driver;
    // Bucketing only means something over a real date column, so the control is
    // offered only when the chosen x-axis is one — otherwise it's an invitation
    // to write a query the database will reject.
    const xColumnType = columns.find((c) => c.name === xField)?.type;
    const shape = CHART_SHAPES.get(chartType);
    const isGrouped = GROUPED_TYPES.has(chartType) && !!xField;
    const canBucket = isGrouped && (xColumnType === "date" || xColumnType === "datetime");
    // Redis has no field to group across keys (see chart-query.ts's fetchRedisWidgetData) — only
    // "number"/"table"-shaped types mean anything there.
    const availableChartTypeDefs =
        selectedDriver === "redis"
            ? CHART_TYPE_DEFS.filter(([, def]) => def.shape === "number" || def.shape === "table")
            : CHART_TYPE_DEFS;

    async function handleSubmit() {
        setError(null);

        if (kind === "text") {
            if (!title.trim()) {
                setError("Title is required");
                return;
            }
            setSaving(true);
            try {
                const payload = { title: title.trim(), kind: "text" as const, content };
                const widget = editingWidget
                    ? await dashboardApi.updateWidget(editingWidget.id, payload)
                    : await dashboardApi.createWidget(payload as unknown as Omit<Widget, "id" | "createdAt">);
                await onSaved(widget);
            } catch (err) {
                setError((err as Error).message);
            } finally {
                setSaving(false);
            }
            return;
        }

        if (!connectionId || !table || !title.trim()) {
            setError("Connection, table, and title are required");
            return;
        }
        if ((shape === "grouped" || shape === "raw") && !xField) {
            setError("This chart type needs an x-axis column");
            return;
        }
        if (shape === "raw" && !yField) {
            setError("This chart type needs a y-axis column");
            return;
        }
        if (shape !== "raw" && aggregation !== "count" && !yField) {
            setError(`"${aggregation}" needs a column to aggregate`);
            return;
        }

        const payload = {
            title: title.trim(),
            kind: "chart" as const,
            connectionId,
            table,
            chartType,
            xField: xField || undefined,
            xField2: PIVOTABLE_TYPES.has(chartType) && xField ? xField2 || undefined : undefined,
            yField: yField || undefined,
            aggregation,
            filters: filters.filter((f) => f.column && (f.value || NULL_OPS.has(f.op ?? "="))),
            xBucket: canBucket && xBucket ? xBucket : undefined,
            limit: limit ? Number(limit) : undefined,
            sortBy: isGrouped && sortBy ? sortBy : undefined,
            sortDir: isGrouped && sortDir ? sortDir : undefined,
            highlightRules: highlightRules.filter((r) => r.color),
            clickParameter: clickParameter || undefined,
            drillEnabled: drillEnabled || undefined,
        };

        setSaving(true);
        try {
            const widget = editingWidget
                ? await dashboardApi.updateWidget(editingWidget.id, payload)
                : await dashboardApi.createWidget(payload);
            await onSaved(widget);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal onClose={onCancel} labelledBy="widget-form-title">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <span id="widget-form-title" className="text-sm font-medium">
                        {editingWidget ? "Edit widget" : "New widget"}
                    </span>
                </CardHeader>
                <CardContent className="max-h-[75vh] space-y-3 overflow-y-auto">
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Title</label>
                        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sales by Region" />
                    </div>

                    {!editingWidget && (
                        <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">Kind</label>
                            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-[11px]">
                                {(["chart", "text"] as const).map((k) => (
                                    <button
                                        key={k}
                                        onClick={() => setKind(k)}
                                        className={`rounded px-1 py-1 capitalize ${kind === k ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                                    >
                                        {k}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {kind === "text" ? (
                        <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">Content</label>
                            <textarea
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                placeholder="Section header or note for this dashboard…"
                                rows={6}
                                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                    ) : (
                        <>
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground">Connection</label>
                                <select
                                    value={connectionId}
                                    onChange={(e) => {
                                        const newId = e.target.value;
                                        setConnectionId(newId);
                                        setTable("");
                                        const newDriver = connections?.find((c) => c.id === newId)?.driver;
                                        if (newDriver === "redis" && chartType !== "number" && chartType !== "table") {
                                            setChartType("number");
                                        }
                                    }}
                                    disabled={connectionsLoading}
                                    className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm disabled:opacity-50"
                                >
                                    <option value="">{connectionsLoading ? "Loading…" : "Select…"}</option>
                                    {connections?.map((c) => {
                                        const target = c.database || c.filePath || "";
                                        // A native <select> popup can't be width-clamped with CSS, so a
                                        // long absolute file path (e.g. a temp-dir sqlite file) blows the
                                        // dropdown out to the viewport width — show just the basename,
                                        // full path on hover via `title`.
                                        const label = c.filePath ? c.filePath.split(/[/\\]/).pop() : target;
                                        return (
                                            <option key={c.id} value={c.id} title={target}>
                                                {c.driver}: {label}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>

                            {connectionId && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Table</label>
                                    <select
                                        value={table}
                                        onChange={(e) => setTable(e.target.value)}
                                        disabled={tablesLoading}
                                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm disabled:opacity-50"
                                    >
                                        <option value="">{tablesLoading ? "Loading tables…" : "Select…"}</option>
                                        {tables?.map((t) => (
                                            <option key={t.name} value={t.name}>
                                                {t.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {table && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Filters</label>
                                    {filters.map((f, i) => {
                                        const op = f.op ?? "=";
                                        const patch = (next: Partial<WidgetFilter>) =>
                                            setFilters(filters.map((x, j) => (j === i ? { ...x, ...next } : x)));
                                        const paramName = placeholderName(f.value);
                                        const isParamMode = paramName !== undefined;
                                        return (
                                            <div key={i} className="flex flex-wrap gap-1">
                                                <select
                                                    value={f.column}
                                                    onChange={(e) => patch({ column: e.target.value })}
                                                    className="h-9 min-w-0 flex-1 basis-24 rounded-md border border-input bg-card px-2 text-sm"
                                                >
                                                    <option value="">Column…</option>
                                                    {columns.map((c) => (
                                                        <option key={c.name} value={c.name}>
                                                            {c.name}
                                                        </option>
                                                    ))}
                                                </select>
                                                <select
                                                    value={op}
                                                    onChange={(e) => patch({ op: e.target.value as FilterOperator })}
                                                    aria-label="Filter operator"
                                                    className="h-9 shrink-0 rounded-md border border-input bg-card px-1 text-sm"
                                                >
                                                    {FILTER_OPS.map((o) => (
                                                        <option key={o.op} value={o.op}>
                                                            {o.label}
                                                        </option>
                                                    ))}
                                                </select>
                                                {!NULL_OPS.has(op) &&
                                                    dashboardParameters &&
                                                    dashboardParameters.length > 0 && (
                                                        <select
                                                            aria-label="Filter value source"
                                                            value={isParamMode ? "param" : "literal"}
                                                            onChange={(e) =>
                                                                patch({
                                                                    value:
                                                                        e.target.value === "param"
                                                                            ? `{{${dashboardParameters[0].name}}}`
                                                                            : "",
                                                                })
                                                            }
                                                            className="h-9 shrink-0 rounded-md border border-input bg-card px-1 text-xs"
                                                        >
                                                            <option value="literal">Literal</option>
                                                            <option value="param">Param</option>
                                                        </select>
                                                    )}
                                                {!NULL_OPS.has(op) &&
                                                    (isParamMode ? (
                                                        <select
                                                            value={paramName}
                                                            onChange={(e) => patch({ value: `{{${e.target.value}}}` })}
                                                            aria-label="Dashboard parameter"
                                                            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-sm"
                                                        >
                                                            {(dashboardParameters ?? []).map((p) => (
                                                                <option key={p.name} value={p.name}>
                                                                    {p.label}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    ) : (
                                                        <Input
                                                            value={f.value}
                                                            onChange={(e) => patch({ value: e.target.value })}
                                                            placeholder={
                                                                op === "in"
                                                                    ? "a, b, c"
                                                                    : op === "like"
                                                                      ? "%term%"
                                                                      : "Value"
                                                            }
                                                            className="min-w-0 flex-1"
                                                        />
                                                    ))}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setFilters(filters.filter((_, j) => j !== i))}
                                                >
                                                    ×
                                                </Button>
                                            </div>
                                        );
                                    })}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setFilters([...filters, { column: "", op: "=", value: "" }])}
                                    >
                                        + Add filter
                                    </Button>
                                </div>
                            )}

                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground">Chart type</label>
                                <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1 text-[11px]">
                                    {availableChartTypeDefs.map(([key, def]) => (
                                        <button
                                            key={key}
                                            onClick={() => setChartType(key)}
                                            className={`rounded px-2 py-1 ${chartType === key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-card/60"}`}
                                        >
                                            {def.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {table && shape !== "number" && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">
                                        {PIVOTABLE_TYPES.has(chartType)
                                            ? "Row grouping (optional)"
                                            : shape === "raw"
                                              ? "X-axis"
                                              : "X-axis (group by)"}
                                    </label>
                                    <select
                                        value={xField}
                                        onChange={(e) => {
                                            setXField(e.target.value);
                                            if (!e.target.value) setXField2("");
                                        }}
                                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                    >
                                        <option value="">
                                            {PIVOTABLE_TYPES.has(chartType) ? "None — raw rows" : "Select…"}
                                        </option>
                                        {columns.map((c) => (
                                            <option key={c.name} value={c.name}>
                                                {c.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {canBucket && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Group dates by</label>
                                    <select
                                        value={xBucket}
                                        onChange={(e) => setXBucket(e.target.value as TimeBucket | "")}
                                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm capitalize"
                                    >
                                        <option value="">Exact value — no bucketing</option>
                                        {TIME_BUCKETS.map((b) => (
                                            <option key={b} value={b}>
                                                {b}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {table && PIVOTABLE_TYPES.has(chartType) && xField && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">
                                        Column grouping (optional — makes a pivot table)
                                    </label>
                                    <select
                                        value={xField2}
                                        onChange={(e) => setXField2(e.target.value)}
                                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                    >
                                        <option value="">None</option>
                                        {columns
                                            .filter((c) => c.name !== xField)
                                            .map((c) => (
                                                <option key={c.name} value={c.name}>
                                                    {c.name}
                                                </option>
                                            ))}
                                    </select>
                                </div>
                            )}

                            {table && shape === "raw" && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Y-axis</label>
                                    <select
                                        value={yField}
                                        onChange={(e) => setYField(e.target.value)}
                                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                    >
                                        <option value="">Select…</option>
                                        {columns.map((c) => (
                                            <option key={c.name} value={c.name}>
                                                {c.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {table && shape !== "raw" && (!PIVOTABLE_TYPES.has(chartType) || xField) && (
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <label className="text-xs text-muted-foreground">Aggregation</label>
                                        <select
                                            value={aggregation}
                                            onChange={(e) => setAggregation(e.target.value as Widget["aggregation"])}
                                            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm capitalize"
                                        >
                                            {AGGREGATIONS.map((a) => (
                                                <option key={a} value={a}>
                                                    {a}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    {aggregation !== "count" && (
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground">Y-axis (aggregate)</label>
                                            <select
                                                value={yField}
                                                onChange={(e) => setYField(e.target.value)}
                                                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                            >
                                                <option value="">Select…</option>
                                                {columns.map((c) => (
                                                    <option key={c.name} value={c.name}>
                                                        {c.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}

                            {table && shape !== "number" && (
                                <div className="grid grid-cols-3 gap-2">
                                    {isGrouped && (
                                        <>
                                            <div className="space-y-1">
                                                <label className="text-xs text-muted-foreground">Sort by</label>
                                                <select
                                                    value={sortBy}
                                                    onChange={(e) =>
                                                        setSortBy(e.target.value as "" | "value" | "label")
                                                    }
                                                    className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                                >
                                                    <option value="">Default</option>
                                                    <option value="value">Value</option>
                                                    <option value="label">Label</option>
                                                </select>
                                            </div>
                                            <div className="space-y-1">
                                                <label className="text-xs text-muted-foreground">Direction</label>
                                                <select
                                                    value={sortDir}
                                                    onChange={(e) => setSortDir(e.target.value as "" | "asc" | "desc")}
                                                    className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                                >
                                                    <option value="">Default</option>
                                                    <option value="desc">Descending</option>
                                                    <option value="asc">Ascending</option>
                                                </select>
                                            </div>
                                        </>
                                    )}
                                    <div className="space-y-1">
                                        <label className="text-xs text-muted-foreground">Max rows</label>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={1000}
                                            value={limit}
                                            onChange={(e) => setLimit(e.target.value)}
                                            placeholder="Auto"
                                        />
                                    </div>
                                </div>
                            )}

                            {table && (shape === "number" || PIVOTABLE_TYPES.has(chartType)) && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Conditional highlighting</label>
                                    {highlightRules.map((r, i) => (
                                        <div key={i} className="flex gap-1">
                                            <select
                                                value={r.operator}
                                                onChange={(e) =>
                                                    setHighlightRules(
                                                        highlightRules.map((x, j) =>
                                                            j === i
                                                                ? {
                                                                      ...x,
                                                                      operator: e.target
                                                                          .value as HighlightRule["operator"],
                                                                  }
                                                                : x
                                                        )
                                                    )
                                                }
                                                className="h-9 rounded-md border border-input bg-card px-1 text-sm"
                                            >
                                                <option value="gt">{">"}</option>
                                                <option value="gte">{"≥"}</option>
                                                <option value="lt">{"<"}</option>
                                                <option value="lte">{"≤"}</option>
                                                <option value="eq">{"="}</option>
                                            </select>
                                            <Input
                                                type="number"
                                                value={r.value}
                                                onChange={(e) =>
                                                    setHighlightRules(
                                                        highlightRules.map((x, j) =>
                                                            j === i ? { ...x, value: Number(e.target.value) } : x
                                                        )
                                                    )
                                                }
                                                placeholder="Threshold"
                                                className="flex-1"
                                            />
                                            <input
                                                type="color"
                                                value={r.color || "#f87171"}
                                                onChange={(e) =>
                                                    setHighlightRules(
                                                        highlightRules.map((x, j) =>
                                                            j === i ? { ...x, color: e.target.value } : x
                                                        )
                                                    )
                                                }
                                                className="h-9 w-9 rounded-md border border-input bg-card"
                                            />
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                    setHighlightRules(highlightRules.filter((_, j) => j !== i))
                                                }
                                            >
                                                ×
                                            </Button>
                                        </div>
                                    ))}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            setHighlightRules([
                                                ...highlightRules,
                                                { operator: "gt", value: 0, color: "#f87171" },
                                            ])
                                        }
                                    >
                                        + Add rule
                                    </Button>
                                </div>
                            )}

                            {table && shape !== "number" && (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">On data-point click</label>
                                    <select
                                        value={clickParameter ? "param" : drillEnabled ? "drill" : "none"}
                                        onChange={(e) => {
                                            const mode = e.target.value;
                                            setClickParameter(
                                                mode === "param" ? (dashboardParameters?.[0]?.name ?? "") : ""
                                            );
                                            setDrillEnabled(mode === "drill");
                                        }}
                                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                    >
                                        <option value="none">Do nothing</option>
                                        {dashboardParameters && dashboardParameters.length > 0 && (
                                            <option value="param">Set a dashboard parameter (cross-filter)</option>
                                        )}
                                        <option value="drill">Open the underlying rows (drill-to-detail)</option>
                                    </select>
                                    {clickParameter && (
                                        <select
                                            value={clickParameter}
                                            onChange={(e) => setClickParameter(e.target.value)}
                                            aria-label="Parameter to set on click"
                                            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                                        >
                                            {(dashboardParameters ?? []).map((p) => (
                                                <option key={p.name} value={p.name}>
                                                    {p.label}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {error && (
                        <div role="alert" className="text-xs text-destructive">
                            {error}
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={handleSubmit} disabled={saving}>
                            {saving ? "Saving…" : editingWidget ? "Save changes" : "Create widget"}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </Modal>
    );
}
