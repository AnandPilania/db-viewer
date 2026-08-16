import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import { Plus, Share2, Copy, Check } from "lucide-react";
import { dashboardApi, type Widget } from "@/lib/api";
import { WidgetForm } from "@/components/WidgetForm";
import { WidgetCard } from "@/components/WidgetCard";
import { Button } from "@/components/ui/button";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ResponsiveGridLayout = WidthProvider(Responsive);

interface Props {
  dashboardId: string;
  onBack: () => void;
}

const COLS = 12;
const ROW_HEIGHT = 28;

export function DashboardBuilder({ dashboardId, onBack }: Props) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
  const [copied, setCopied] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    (rglLayout: Layout[]) => {
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

  const rglLayout: Layout[] = dashboard.layout.map((item) => ({
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
            <Button size="sm" variant="ghost" onClick={copyEmbedCode}>
              {copied ? <Check size={12} /> : <Copy size={12} />} Copy embed code
            </Button>
          )}
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus size={12} /> Add widget
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {dashboard.layout.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No widgets yet — add one to get started.
          </div>
        ) : (
          <ResponsiveGridLayout
            className="layout"
            layouts={{ lg: rglLayout }}
            breakpoints={{ lg: 0 }}
            cols={{ lg: COLS }}
            rowHeight={ROW_HEIGHT}
            margin={[12, 12]}
            draggableHandle=".widget-drag-handle"
            onLayoutChange={handleLayoutChange}
          >
            {dashboard.layout.map((item) => {
              const widget = allWidgets?.find((w) => w.id === item.widgetId);
              if (!widget) return null;
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
                  />
                </div>
              );
            })}
          </ResponsiveGridLayout>
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
