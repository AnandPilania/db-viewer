import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus, Trash2, Plug } from "lucide-react";
import { api } from "@/lib/api";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface Props {
  onSelect: (connectionId: string) => void;
}

export function ConnectionsPicker({ onSelect }: Props) {
  const { data: connections, isLoading } = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  if (showForm || (!isLoading && connections?.length === 0)) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="space-y-3">
          {connections && connections.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              ← Back to saved connections
            </Button>
          )}
          <ConnectionForm onConnected={onSelect} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="flex items-center gap-2">
          <Database size={16} className="text-accent" />
          <span className="text-sm font-medium">Saved connections</span>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {connections?.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/60 px-3 py-2"
            >
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(c.id)}>
                <Plug size={14} className="shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="truncate text-sm">{c.database || c.filePath || c.host || c.id}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.driver}
                    {c.host ? ` · ${c.host}:${c.port ?? ""}` : ""}
                  </div>
                </div>
              </button>
              <button
                onClick={() => deleteMutation.mutate(c.id)}
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="Delete connection"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <Button variant="secondary" className="w-full" onClick={() => setShowForm(true)}>
            <Plus size={14} /> New connection
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
