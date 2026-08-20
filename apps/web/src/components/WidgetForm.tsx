import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { dashboardApi, type Widget } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";

interface Props {
  onCancel: () => void;
  onSaved: (widget: Widget) => void;
  /** When provided, the form edits this widget (pre-filled, submits via PATCH) instead of creating a new one. */
  editingWidget?: Widget;
}

const CHART_TYPES: Widget["chartType"][] = ["bar", "line", "pie", "number", "table"];
const AGGREGATIONS: Widget["aggregation"][] = ["count", "sum", "avg", "min", "max"];

export function WidgetForm({ onCancel, onSaved, editingWidget }: Props) {
  const { data: connections } = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const [connectionId, setConnectionId] = useState(editingWidget?.connectionId ?? "");
  const [table, setTable] = useState(editingWidget?.table ?? "");
  const [title, setTitle] = useState(editingWidget?.title ?? "");
  const [chartType, setChartType] = useState<Widget["chartType"]>(editingWidget?.chartType ?? "bar");
  const [xField, setXField] = useState(editingWidget?.xField ?? "");
  const [yField, setYField] = useState(editingWidget?.yField ?? "");
  const [aggregation, setAggregation] = useState<Widget["aggregation"]>(editingWidget?.aggregation ?? "count");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: tables } = useQuery({
    queryKey: ["tables", connectionId],
    queryFn: () => api.listTables(connectionId),
    enabled: !!connectionId,
  });

  const columns = tables?.find((t) => t.name === table)?.columns ?? [];
  const selectedDriver = connections?.find((c) => c.id === connectionId)?.driver;
  const availableChartTypes =
    selectedDriver === "redis" ? (["number", "table"] as const) : CHART_TYPES;

  async function handleSubmit() {
    setError(null);
    if (!connectionId || !table || !title.trim()) {
      setError("Connection, table, and title are required");
      return;
    }
    if ((chartType === "bar" || chartType === "line" || chartType === "pie") && !xField) {
      setError("This chart type needs an x-axis column");
      return;
    }
    if (aggregation !== "count" && !yField) {
      setError(`"${aggregation}" needs a column to aggregate`);
      return;
    }

    const payload = {
      title: title.trim(),
      connectionId,
      table,
      chartType,
      xField: xField || undefined,
      yField: yField || undefined,
      aggregation,
    };

    setSaving(true);
    try {
      const widget = editingWidget
        ? await dashboardApi.updateWidget(editingWidget.id, payload)
        : await dashboardApi.createWidget(payload);
      onSaved(widget);
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
              className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="">Select…</option>
              {connections?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.driver}: {c.database || c.filePath}
                </option>
              ))}
            </select>
          </div>

          {connectionId && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Table</label>
              <select
                value={table}
                onChange={(e) => setTable(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
              >
                <option value="">Select…</option>
                {tables?.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Chart type</label>
            <div className="grid grid-cols-5 gap-1 rounded-md bg-muted p-1 text-[11px]">
              {availableChartTypes.map((ct) => (
                <button
                  key={ct}
                  onClick={() => setChartType(ct)}
                  className={`rounded px-1 py-1 capitalize ${chartType === ct ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                >
                  {ct}
                </button>
              ))}
            </div>
          </div>

          {table && chartType !== "table" && (
            <>
              {chartType !== "number" && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">X-axis (group by)</label>
                  <select
                    value={xField}
                    onChange={(e) => setXField(e.target.value)}
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
