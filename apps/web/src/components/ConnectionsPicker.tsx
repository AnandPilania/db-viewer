import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus, Trash2, Plug, Pencil, Zap, ArrowLeft, Search } from "lucide-react";
import type { ConnectionConfig } from "@pilaniaanand/driver-interface";
import { api } from "@/lib/api";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** What a card actually shows/searches — the label line, driver, and host. */
function connectionLabel(c: ConnectionConfig): string {
    return [c.database || c.filePath || c.host || c.id, c.driver, c.host].filter(Boolean).join(" ");
}

interface Props {
    onSelect: (connectionId: string) => void;
    /** Shown as a back arrow in the header, when there's an active session to return to. */
    onBack?: () => void;
}

export function ConnectionsPicker({ onSelect, onBack }: Props) {
    const { data: connections, isLoading } = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
    const [showForm, setShowForm] = useState(false);
    const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
    const [search, setSearch] = useState("");
    // Last test result per connection id, cleared as soon as a new test starts.
    const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message?: string }>>({});
    const queryClient = useQueryClient();

    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.deleteConnection(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
    });

    const testMutation = useMutation({
        mutationFn: (id: string) => api.testExistingConnection(id),
        onSuccess: (result, id) => setTestResults((prev) => ({ ...prev, [id]: result })),
        onError: (err: Error, id) => setTestResults((prev) => ({ ...prev, [id]: { ok: false, message: err.message } })),
    });

    if (editingConnection) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <ConnectionForm
                    editing={editingConnection}
                    onBack={() => setEditingConnection(null)}
                    onConnected={() => setEditingConnection(null)}
                />
            </div>
        );
    }

    if (showForm || (!isLoading && connections?.length === 0)) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <ConnectionForm
                    onConnected={onSelect}
                    onBack={connections && connections.length > 0 ? () => setShowForm(false) : undefined}
                />
            </div>
        );
    }

    return (
        <div className="flex h-screen items-center justify-center bg-background">
            <Card className="w-full max-w-md">
                <CardHeader className="flex items-center gap-2">
                    {onBack && (
                        <button
                            onClick={onBack}
                            aria-label="Back"
                            className="-ml-1 rounded p-1 text-muted-foreground hover:bg-muted"
                        >
                            <ArrowLeft size={14} />
                        </button>
                    )}
                    <Database size={16} className="text-accent" />
                    <span className="text-sm font-medium">Saved connections</span>
                </CardHeader>
                <CardContent className="space-y-2">
                    {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
                    {connections && connections.length > 5 && (
                        <div className="relative">
                            <Search
                                size={12}
                                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                            />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search connections…"
                                className="h-8 pl-8"
                            />
                        </div>
                    )}
                    {connections
                        ?.filter((c) => connectionLabel(c).toLowerCase().includes(search.trim().toLowerCase()))
                        .map((c) => (
                            <div
                                key={c.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/60 px-3 py-2"
                            >
                                <button
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    onClick={() => onSelect(c.id)}
                                >
                                    <Plug size={14} className="shrink-0 text-accent" />
                                    <div className="min-w-0">
                                        <div className="truncate text-sm">
                                            {c.database || c.filePath || c.host || c.id}
                                        </div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {c.driver}
                                            {c.host ? ` · ${c.host}:${c.port ?? ""}` : ""}
                                        </div>
                                    </div>
                                </button>
                                {testResults[c.id] && (
                                    <span
                                        title={testResults[c.id].message}
                                        className={`shrink-0 text-[10px] ${testResults[c.id].ok ? "text-emerald-500" : "text-destructive"}`}
                                    >
                                        {testResults[c.id].ok ? "OK" : "Failed"}
                                    </span>
                                )}
                                <button
                                    onClick={() => {
                                        setTestResults((prev) => {
                                            const { [c.id]: _, ...rest } = prev;
                                            return rest;
                                        });
                                        testMutation.mutate(c.id);
                                    }}
                                    disabled={testMutation.isPending && testMutation.variables === c.id}
                                    className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent/10 hover:text-accent"
                                    aria-label="Test connection"
                                >
                                    <Zap size={14} />
                                </button>
                                <button
                                    onClick={() => setEditingConnection(c)}
                                    className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent/10 hover:text-accent"
                                    aria-label="Edit connection"
                                >
                                    <Pencil size={14} />
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
