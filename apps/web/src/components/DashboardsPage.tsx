import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Plus, Trash2 } from "lucide-react";
import { dashboardApi } from "@/lib/api";
import { DashboardBuilder } from "@/components/DashboardBuilder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function DashboardsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const queryClient = useQueryClient();

  const { data: dashboards } = useQuery({ queryKey: ["dashboards"], queryFn: dashboardApi.listDashboards });

  const createMutation = useMutation({
    mutationFn: (title: string) => dashboardApi.createDashboard(title),
    onSuccess: (dashboard) => {
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setNewTitle("");
      setOpenId(dashboard.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => dashboardApi.deleteDashboard(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
  });

  if (openId) {
    return <DashboardBuilder dashboardId={openId} onBack={() => setOpenId(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <LayoutGrid size={16} className="text-accent" />
        <span className="text-sm font-medium">Dashboards</span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New dashboard title"
            className="h-8 w-56"
            onKeyDown={(e) => e.key === "Enter" && newTitle.trim() && createMutation.mutate(newTitle.trim())}
          />
          <Button size="sm" onClick={() => newTitle.trim() && createMutation.mutate(newTitle.trim())}>
            <Plus size={12} /> Create
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {!dashboards || dashboards.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No dashboards yet — create one above.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {dashboards.map((d) => (
              <div
                key={d.id}
                role="button"
                tabIndex={0}
                aria-label={`Open dashboard "${d.title}"`}
                className="group flex cursor-pointer flex-col rounded-lg border border-border bg-card p-3 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setOpenId(d.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenId(d.id);
                  }
                }}
              >
                <div className="flex items-start justify-between">
                  <span className="text-sm font-medium">{d.title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate(d.id);
                    }}
                    aria-label={`Delete dashboard "${d.title}"`}
                    className="text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {d.layout.length} widget{d.layout.length === 1 ? "" : "s"}
                  {d.embedEnabled && " · embed enabled"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
