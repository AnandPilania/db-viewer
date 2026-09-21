import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import { Plus, Share2, Copy, Check, RotateCw } from "lucide-react";
import { dashboardApi, type Widget } from "@/lib/api";
import { WidgetForm } from "@/components/WidgetForm";
import { WidgetCard } from "@/components/WidgetCard";
import { Button } from "@/components/ui/button";
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

interface Props {
    dashboardId: string;
    onBack: () => void;
}

const COLS = 12;
const ROW_HEIGHT = 28;
const MARGIN: [number, number] = [12, 12];

export function DashboardBuilder({ dashboardId, onBack }: Props) {
    const queryClient = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
    const [copied, setCopied] = useState(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { width, containerRef, mounted } = useContainerWidth();

    const { data: dashboard } = useQuery({
        queryKey: ["dashboard", dashboardId],
        queryFn: () => dashboardApi.getDashboard(dashboardId),
    });

    const { data: allWidgets } = useQuery({ queryKey: ["widgets"], queryFn: dashboardApi.listWidgets });

    async function addWidgetToLayout(widgetId: string) {
        if (!dashboard) return;
        const nextY = dashboard.layout.length ? Math.max(...dashboard.layout.map((l) => l.y + l.h)) : 0;
        const newLayout = [...dashboard.layout, { widgetId, x: 0, y: nextY, w: 6, h: 4 }];
        await dashboardApi.updateDashboard(dashboardId, { layout: newLayout });
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    }

    async function removeFromLayout(widgetId: string) {
        if (!dashboard) return;
        const newLayout = dashboard.layout.filter((l) => l.widgetId !== widgetId);
        await dashboardApi.updateDashboard(dashboardId, { layout: newLayout });
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    }

    async function toggleEmbed() {
        if (!dashboard) return;
        await dashboardApi.setEmbed(dashboardId, !dashboard.embedEnabled);
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    }

    async function rotateEmbedToken() {
        if (!dashboard) return;
        // Deliberately confirmed: this breaks every link already handed out.
        if (!window.confirm("Rotate this embed token? Any link already shared will stop working immediately.")) return;
        await dashboardApi.rotateEmbedToken(dashboardId);
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    }

    function copyEmbedCode() {
        if (!dashboard?.shareToken) return;
        const url = `${window.location.origin}/embed/${dashboardId}?token=${dashboard.shareToken}`;
        const iframe = `<iframe src="${url}" width="100%" height="600" frameborder="0"></iframe>`;
        navigator.clipboard.writeText(iframe);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
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
                    <Button size="sm" variant={dashboard.embedEnabled ? "secondary" : "ghost"} onClick={toggleEmbed}>
                        <Share2 size={12} /> {dashboard.embedEnabled ? "Embedding on" : "Enable embed"}
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
                                title="Issue a new token and invalidate the current link"
                            >
                                <RotateCw size={12} /> Rotate token
                            </Button>
                            <span
                                className="text-[10px] text-muted-foreground"
                                title={dashboard.shareTokenExpiresAt ?? undefined}
                            >
                                {embedExpiryLabel(dashboard.shareTokenExpiresAt)}
                            </span>
                        </>
                    )}
                    <Button size="sm" onClick={() => setShowForm(true)}>
                        <Plus size={12} /> Add widget
                    </Button>
                </div>
            </div>

            <div ref={containerRef} className="flex-1 overflow-auto p-3">
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
                            gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: MARGIN }}
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
                                            fetchData={() => dashboardApi.widgetData(widget.id)}
                                            onRemove={() => removeFromLayout(widget.id)}
                                            onEdit={() => setEditingWidget(widget)}
                                            dragHandleClassName="widget-drag-handle"
                                            connectionId={widget.connectionId}
                                            table={widget.table}
                                            highlightRules={widget.highlightRules}
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
                    onCancel={() => setShowForm(false)}
                    onSaved={async (widget) => {
                        setShowForm(false);
                        queryClient.invalidateQueries({ queryKey: ["widgets"] });
                        await addWidgetToLayout(widget.id);
                    }}
                />
            )}

            {editingWidget && (
                <WidgetForm
                    editingWidget={editingWidget}
                    onCancel={() => setEditingWidget(null)}
                    onSaved={(widget) => {
                        setEditingWidget(null);
                        queryClient.invalidateQueries({ queryKey: ["widgets"] });
                        queryClient.invalidateQueries({ queryKey: ["widget-data", widget.id] });
                    }}
                />
            )}
        </div>
    );
}
