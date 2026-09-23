import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import { Plus, Share2, Copy, Check, RotateCw, SlidersHorizontal, Flag } from "lucide-react";
import { nanoid } from "nanoid";
import {
    dashboardApi,
    widgetParamNames,
    type DashboardAnnotation,
    type DashboardParameter,
    type Widget,
} from "./api.js";
import { WidgetForm } from "./WidgetForm.js";
import { WidgetCard } from "./WidgetCard.js";
import { ParameterFilterBar } from "./ParameterFilterBar.js";
import { Button, Input, Modal, Card, CardHeader, CardContent, Toaster, toast } from "./ui.js";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

/** An expired link fails with a 403 the embedder can't diagnose, so say when it lapses before it does. */
function embedExpiryLabel(expiresAt: string | null | undefined): string {
    if (!expiresAt) return "never expires";
    const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000);
    if (days < 0) return "expired — rotate to re-enable";
    if (days === 0) return "expires today";
    return `expires in ${days}d`;
}

/** Underlying rows for a clicked data point — see B3's drill-to-detail. Derived entirely from the widget's own saved query (table/xField), no new stored config beyond the `drillEnabled` flag. */
export interface DrillTarget {
    connectionId: string;
    table: string;
    column: string;
    value: unknown;
}

interface Props {
    dashboardId: string;
    onBack: () => void;
    /** Wired in from the module's install() options — see index.ts. Undefined means drill-to-detail is a no-op (the host app didn't supply a navigation target). */
    onDrillToTable?: (target: DrillTarget) => void;
}

const COLS = 12;
const ROW_HEIGHT = 28;
const MARGIN: [number, number] = [12, 12];

export function DashboardBuilder({ dashboardId, onBack, onDrillToTable }: Props) {
    const queryClient = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
    const [copied, setCopied] = useState(false);
    const [secretRevealed, setSecretRevealed] = useState(false);
    const [secretCopied, setSecretCopied] = useState(false);
    const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
    const [editingParams, setEditingParams] = useState<DashboardParameter[] | null>(null);
    const [editingAnnotations, setEditingAnnotations] = useState<DashboardAnnotation[] | null>(null);
    const [savingAnnotations, setSavingAnnotations] = useState(false);
    const [removingWidgetId, setRemovingWidgetId] = useState<string | null>(null);
    const [togglingEmbed, setTogglingEmbed] = useState(false);
    const [rotatingToken, setRotatingToken] = useState(false);
    const [savingParams, setSavingParams] = useState(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const secretPopoverRef = useRef<HTMLDivElement>(null);
    const { width, containerRef, mounted } = useContainerWidth();

    useEffect(() => {
        if (!secretRevealed) return;
        function onPointerDown(e: PointerEvent) {
            if (!secretPopoverRef.current?.contains(e.target as Node)) setSecretRevealed(false);
        }
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [secretRevealed]);

    const { data: dashboard } = useQuery({
        queryKey: ["dashboard", dashboardId],
        queryFn: () => dashboardApi.getDashboard(dashboardId),
    });

    const { data: allWidgets } = useQuery({ queryKey: ["widgets"], queryFn: dashboardApi.listWidgets });

    // Seeds the filter bar from each parameter's defaultValue once, the first
    // time this dashboard's data arrives — not on every refetch, or a viewer's
    // own in-progress edits would get stomped back to defaults.
    const defaultsSeeded = useRef<string | null>(null);
    useEffect(() => {
        if (!dashboard || defaultsSeeded.current === dashboard.id) return;
        defaultsSeeded.current = dashboard.id;
        const defaults: Record<string, unknown> = {};
        for (const p of dashboard.parameters ?? []) {
            if (p.defaultValue !== undefined) defaults[p.name] = p.defaultValue;
        }
        setParamValues(defaults);
    }, [dashboard]);

    /** The subset of paramValues this widget's filters actually reference — passed to WidgetCard so only affected widgets refetch. */
    function paramsFor(widget: Widget): Record<string, unknown> {
        const subset: Record<string, unknown> = {};
        for (const name of widgetParamNames(widget)) {
            if (paramValues[name] !== undefined && paramValues[name] !== "") subset[name] = paramValues[name];
        }
        return subset;
    }

    /**
     * A data-point click means one of two things, decided per-widget at
     * authoring time (WidgetForm's "On data-point click" control) — never
     * both: `clickParameter` set means cross-filtering (B2, reuses the exact
     * same paramValues state the filter bar writes to), `drillEnabled` means
     * drill-to-detail (B3, table/column come from the widget's own saved
     * query, not new stored config).
     */
    function handleWidgetClick(widget: Widget, value: unknown) {
        if (widget.clickParameter) {
            setParamValues((v) => ({ ...v, [widget.clickParameter!]: value }));
        } else if (widget.drillEnabled && widget.xField) {
            onDrillToTable?.({ connectionId: widget.connectionId, table: widget.table, column: widget.xField, value });
        }
    }

    async function saveParameters() {
        if (!editingParams) return;
        setSavingParams(true);
        try {
            await dashboardApi.updateDashboard(dashboardId, {
                parameters: editingParams.filter((p) => p.name.trim() && p.label.trim()),
            });
            queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
            setEditingParams(null);
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSavingParams(false);
        }
    }

    function updateParamDraft(i: number, patch: Partial<DashboardParameter>) {
        setEditingParams((prev) => prev && prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    }

    async function saveAnnotations() {
        if (!editingAnnotations) return;
        setSavingAnnotations(true);
        try {
            await dashboardApi.updateDashboard(dashboardId, {
                annotations: editingAnnotations.filter((a) => a.date && a.label.trim()),
            });
            queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
            setEditingAnnotations(null);
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSavingAnnotations(false);
        }
    }

    function updateAnnotationDraft(i: number, patch: Partial<DashboardAnnotation>) {
        setEditingAnnotations((prev) => prev && prev.map((a, j) => (j === i ? { ...a, ...patch } : a)));
    }

    async function addWidgetToLayout(widgetId: string) {
        if (!dashboard) return;
        const nextY = dashboard.layout.length ? Math.max(...dashboard.layout.map((l) => l.y + l.h)) : 0;
        const newLayout = [...dashboard.layout, { widgetId, x: 0, y: nextY, w: 6, h: 4 }];
        await dashboardApi.updateDashboard(dashboardId, { layout: newLayout });
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    }

    async function removeFromLayout(widgetId: string) {
        if (!dashboard) return;
        setRemovingWidgetId(widgetId);
        try {
            const newLayout = dashboard.layout.filter((l) => l.widgetId !== widgetId);
            await dashboardApi.updateDashboard(dashboardId, { layout: newLayout });
            queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setRemovingWidgetId(null);
        }
    }

    async function toggleEmbed() {
        if (!dashboard) return;
        setTogglingEmbed(true);
        try {
            await dashboardApi.setEmbed(dashboardId, !dashboard.embedEnabled);
            queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setTogglingEmbed(false);
        }
    }

    async function rotateEmbedToken() {
        if (!dashboard) return;
        // Deliberately confirmed: this breaks every link already handed out.
        if (!window.confirm("Rotate this embed token? Any link already shared will stop working immediately.")) return;
        setRotatingToken(true);
        try {
            await dashboardApi.rotateEmbedToken(dashboardId);
            queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setRotatingToken(false);
        }
    }

    function copyEmbedCode() {
        if (!dashboard?.shareToken) return;
        const url = `${window.location.origin}/embed/${dashboardId}?token=${dashboard.shareToken}`;
        const iframe = `<iframe src="${url}" width="100%" height="600" frameborder="0"></iframe>`;
        navigator.clipboard.writeText(iframe);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    function copyEmbedSecret() {
        if (!dashboard?.embedSecret) return;
        navigator.clipboard.writeText(dashboard.embedSecret);
        setSecretCopied(true);
        setTimeout(() => setSecretCopied(false), 2000);
    }

    // Debounced persistence: react-grid-layout fires onLayoutChange
    // continuously while dragging/resizing, so we save to the server only
    // once the user pauses, not on every intermediate frame.
    const handleLayoutChange = useCallback(
        (rglLayout: Layout) => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
                const newLayout = rglLayout.map((item) => ({
                    widgetId: item.i,
                    x: item.x,
                    y: item.y,
                    w: item.w,
                    h: item.h,
                }));
                dashboardApi.updateDashboard(dashboardId, { layout: newLayout }).then(() => {
                    queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
                });
            }, 500);
        },
        [dashboardId, queryClient]
    );

    if (!dashboard) return null;

    /**
     * Layout entries whose widget actually exists, resolved before anything is
     * rendered. The grid and its children must be built from this same list:
     * react-grid-layout matches a layout entry to a child by key, and any child
     * it can't match gets defaults (1x1 at the origin) — which the debounced
     * save then writes back as the real layout. Rendering a null child while
     * the widget list was still loading was enough to flatten every card to 1x1
     * on the next refresh.
     */
    const items = allWidgets
        ? dashboard.layout.flatMap((item) => {
              const widget = allWidgets.find((w) => w.id === item.widgetId);
              return widget ? [{ item, widget }] : [];
          })
        : [];

    const rglLayout: Layout = items.map(({ item }) => ({
        i: item.widgetId,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        minW: 2,
        minH: 2,
    }));

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div className="flex items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={onBack}>
                        ← Dashboards
                    </Button>
                    <span className="text-sm font-medium">{dashboard.title}</span>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant={dashboard.embedEnabled ? "secondary" : "ghost"}
                        onClick={toggleEmbed}
                        disabled={togglingEmbed}
                    >
                        <Share2 size={12} />{" "}
                        {togglingEmbed ? "Working…" : dashboard.embedEnabled ? "Embedding on" : "Enable embed"}
                    </Button>
                    {dashboard.embedEnabled && (
                        <>
                            <Button size="sm" variant="ghost" onClick={copyEmbedCode}>
                                {copied ? <Check size={12} /> : <Copy size={12} />} Copy embed code
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={rotateEmbedToken}
                                disabled={rotatingToken}
                                title="Issue a new token and invalidate the current link"
                                className="relative pb-4"
                            >
                                <span className="inline-flex items-center gap-1.5">
                                    <RotateCw size={12} className={rotatingToken ? "animate-spin" : undefined} />{" "}
                                    {rotatingToken ? "Rotating…" : "Rotate token"}
                                </span>
                                <span
                                    className="absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground font-normal leading-none"
                                    title={dashboard.shareTokenExpiresAt ?? undefined}
                                >
                                    {embedExpiryLabel(dashboard.shareTokenExpiresAt)}
                                </span>
                            </Button>
                            {/* Signed-embed secret (Part C) — a host app mints its own JWT
                                with this to lock params to a viewer's identity. Rotates
                                together with the share token above (same button, same
                                lifecycle) since a leaked link and a leaked secret are the
                                same kind of incident. Shown in an absolutely-positioned
                                popover (not inline) so the long secret string can't push
                                the toolbar's other buttons around or wrap the row. */}
                            <div className="relative" ref={secretPopoverRef}>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setSecretRevealed((v) => !v)}
                                    title="Signed-embed secret — for a host app to mint its own JWT (see docs)"
                                >
                                    {secretRevealed ? "Hide secret" : "Reveal secret"}
                                </Button>
                                {secretRevealed && dashboard.embedSecret && (
                                    <div className="absolute right-0 top-full z-20 mt-1 flex items-center gap-1.5 rounded-md border border-border bg-card p-1.5 shadow-lg">
                                        <code className="max-w-[240px] truncate rounded bg-muted px-1.5 py-0.5 text-[10px]">
                                            {dashboard.embedSecret}
                                        </code>
                                        <Button size="sm" variant="ghost" onClick={copyEmbedSecret}>
                                            {secretCopied ? <Check size={12} /> : <Copy size={12} />}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingParams(dashboard.parameters ? [...dashboard.parameters] : [])}
                    >
                        <SlidersHorizontal size={12} /> Parameters
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingAnnotations(dashboard.annotations ? [...dashboard.annotations] : [])}
                    >
                        <Flag size={12} /> Annotations
                    </Button>
                    <Button size="sm" onClick={() => setShowForm(true)}>
                        <Plus size={12} /> Add widget
                    </Button>
                </div>
            </div>

            <ParameterFilterBar
                parameters={dashboard.parameters ?? []}
                values={paramValues}
                onChange={(name, value) => setParamValues((v) => ({ ...v, [name]: value }))}
            />

            {dashboard.annotations && dashboard.annotations.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
                    {[...dashboard.annotations]
                        .sort((a, b) => a.date.localeCompare(b.date))
                        .map((a) => (
                            <span
                                key={a.id}
                                className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
                                title={a.label}
                            >
                                <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: a.color || "#f59e0b" }}
                                />
                                {a.date} — {a.label}
                            </span>
                        ))}
                </div>
            )}

            {/*
                No CSS padding here: useContainerWidth measures this element's own box,
                so padding on it would shrink the *visible* area below the `width` GridLayout
                is told to render into — items would then be laid out for the wider,
                unpadded figure and overflow past the (padding-eaten) right edge while the
                left edge looked fine, because items start flush with the content box's
                left edge either way. `containerPadding` below achieves the same inset
                without that mismatch, symmetrically on both edges.
            */}
            <div ref={containerRef} className="flex-1 overflow-auto">
                {allWidgets && items.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        No widgets yet — add one to get started.
                    </div>
                ) : (
                    mounted &&
                    items.length > 0 && (
                        <GridLayout
                            className="layout"
                            layout={rglLayout}
                            width={width}
                            gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: MARGIN, containerPadding: MARGIN }}
                            dragConfig={{ handle: ".widget-drag-handle" }}
                            onLayoutChange={handleLayoutChange}
                        >
                            {items.map(({ item, widget }) => {
                                return (
                                    <div key={item.widgetId}>
                                        <WidgetCard
                                            id={widget.id}
                                            title={widget.title}
                                            chartType={widget.chartType}
                                            kind={widget.kind}
                                            content={widget.content}
                                            fetchData={() => dashboardApi.widgetData(widget.id, paramsFor(widget))}
                                            onRemove={() => removeFromLayout(widget.id)}
                                            removing={removingWidgetId === widget.id}
                                            onEdit={() => setEditingWidget(widget)}
                                            dragHandleClassName="widget-drag-handle"
                                            connectionId={widget.connectionId}
                                            table={widget.table}
                                            highlightRules={widget.highlightRules}
                                            params={paramsFor(widget)}
                                            onDataPointClick={
                                                widget.clickParameter || widget.drillEnabled
                                                    ? (value) => handleWidgetClick(widget, value)
                                                    : undefined
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </GridLayout>
                    )
                )}
            </div>

            {showForm && (
                <WidgetForm
                    dashboardParameters={dashboard.parameters}
                    onCancel={() => setShowForm(false)}
                    onSaved={async (widget) => {
                        queryClient.invalidateQueries({ queryKey: ["widgets"] });
                        await addWidgetToLayout(widget.id);
                        setShowForm(false);
                    }}
                />
            )}

            {editingWidget && (
                <WidgetForm
                    editingWidget={editingWidget}
                    dashboardParameters={dashboard.parameters}
                    onCancel={() => setEditingWidget(null)}
                    onSaved={(widget) => {
                        setEditingWidget(null);
                        queryClient.invalidateQueries({ queryKey: ["widgets"] });
                        queryClient.invalidateQueries({ queryKey: ["widget-data", widget.id] });
                    }}
                />
            )}

            {editingParams && (
                <Modal onClose={() => setEditingParams(null)} labelledBy="dashboard-params-title">
                    <Card className="w-full max-w-lg">
                        <CardHeader>
                            <span id="dashboard-params-title" className="text-sm font-medium">
                                Dashboard parameters
                            </span>
                        </CardHeader>
                        <CardContent className="max-h-[75vh] space-y-2 overflow-y-auto">
                            {editingParams.map((p, i) => (
                                <div key={i} className="flex flex-wrap items-center gap-1">
                                    <Input
                                        value={p.name}
                                        onChange={(e) => updateParamDraft(i, { name: e.target.value })}
                                        placeholder="name"
                                        className="w-24"
                                    />
                                    <Input
                                        value={p.label}
                                        onChange={(e) => updateParamDraft(i, { label: e.target.value })}
                                        placeholder="label"
                                        className="w-28"
                                    />
                                    <select
                                        value={p.type}
                                        onChange={(e) =>
                                            updateParamDraft(i, { type: e.target.value as DashboardParameter["type"] })
                                        }
                                        className="h-9 rounded-md border border-input bg-card px-1 text-sm"
                                    >
                                        <option value="text">text</option>
                                        <option value="number">number</option>
                                        <option value="date">date</option>
                                        <option value="select">select</option>
                                    </select>
                                    <Input
                                        value={p.defaultValue !== undefined ? String(p.defaultValue) : ""}
                                        onChange={(e) =>
                                            updateParamDraft(i, { defaultValue: e.target.value || undefined })
                                        }
                                        placeholder="default"
                                        className="w-24"
                                    />
                                    {p.type === "select" && (
                                        <Input
                                            value={(p.options ?? []).join(",")}
                                            onChange={(e) =>
                                                updateParamDraft(i, {
                                                    options: e.target.value
                                                        .split(",")
                                                        .map((s) => s.trim())
                                                        .filter(Boolean),
                                                })
                                            }
                                            placeholder="option, option"
                                            className="w-36"
                                        />
                                    )}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setEditingParams(editingParams.filter((_, j) => j !== i))}
                                    >
                                        ×
                                    </Button>
                                </div>
                            ))}
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                    setEditingParams([...editingParams, { name: "", label: "", type: "text" }])
                                }
                            >
                                + Add parameter
                            </Button>
                            <div className="flex justify-end gap-2 pt-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingParams(null)}
                                    disabled={savingParams}
                                >
                                    Cancel
                                </Button>
                                <Button size="sm" onClick={saveParameters} disabled={savingParams}>
                                    {savingParams ? "Saving…" : "Save"}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </Modal>
            )}

            {editingAnnotations && (
                <Modal onClose={() => setEditingAnnotations(null)} labelledBy="dashboard-annotations-title">
                    <Card className="w-full max-w-lg">
                        <CardHeader>
                            <span id="dashboard-annotations-title" className="text-sm font-medium">
                                Annotations
                            </span>
                        </CardHeader>
                        <CardContent className="max-h-[75vh] space-y-2 overflow-y-auto">
                            {editingAnnotations.map((a, i) => (
                                <div key={a.id} className="flex flex-wrap items-center gap-1">
                                    <Input
                                        type="date"
                                        value={a.date}
                                        onChange={(e) => updateAnnotationDraft(i, { date: e.target.value })}
                                        className="w-36"
                                    />
                                    <Input
                                        value={a.label}
                                        onChange={(e) => updateAnnotationDraft(i, { label: e.target.value })}
                                        placeholder="e.g. Deploy shipped"
                                        className="min-w-0 flex-1"
                                    />
                                    <input
                                        type="color"
                                        value={a.color || "#f59e0b"}
                                        onChange={(e) => updateAnnotationDraft(i, { color: e.target.value })}
                                        className="h-9 w-9 rounded-md border border-input bg-card"
                                    />
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            setEditingAnnotations(editingAnnotations.filter((_, j) => j !== i))
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
                                    setEditingAnnotations([
                                        ...editingAnnotations,
                                        {
                                            id: nanoid(),
                                            date: new Date().toISOString().slice(0, 10),
                                            label: "",
                                            color: "#f59e0b",
                                        },
                                    ])
                                }
                            >
                                + Add annotation
                            </Button>
                            <div className="flex justify-end gap-2 pt-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingAnnotations(null)}
                                    disabled={savingAnnotations}
                                >
                                    Cancel
                                </Button>
                                <Button size="sm" onClick={saveAnnotations} disabled={savingAnnotations}>
                                    {savingAnnotations ? "Saving…" : "Save"}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </Modal>
            )}
            <Toaster />
        </div>
    );
}
