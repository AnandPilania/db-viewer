import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Table2, ChevronRight, Search } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface Props {
    connectionId: string | null;
    selectedTable: string | null;
    onSelectTable: (table: string) => void;
}

export function SchemaSidebar({ connectionId, selectedTable, onSelectTable }: Props) {
    const [search, setSearch] = useState("");
    const { data: connections } = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
    const { data: tables, isLoading } = useQuery({
        queryKey: ["tables", connectionId],
        queryFn: () => api.listTables(connectionId!),
        enabled: !!connectionId,
    });

    const activeConnection = connections?.find((c) => c.id === connectionId);
    const filteredTables = tables?.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()));

    return (
        <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card/40">
            <div className="flex items-center gap-2 border-b border-border px-3 py-3">
                <Database size={16} className="text-accent" />
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                        {activeConnection?.database || activeConnection?.filePath || "No connection"}
                    </div>
                    {activeConnection && (
                        <div className="truncate text-xs text-muted-foreground">{activeConnection.driver}</div>
                    )}
                </div>
            </div>

            {connectionId && tables && tables.length > 0 && (
                <div className="relative border-b border-border px-2 py-1.5">
                    <Search
                        size={12}
                        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search tables…"
                        className="h-7 pl-7 text-xs"
                    />
                </div>
            )}

            <div className="flex-1 overflow-y-auto py-1">
                {isLoading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading tables…</div>}
                {!connectionId && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                        Connect to a database to browse tables.
                    </div>
                )}
                {tables && filteredTables?.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No tables match &quot;{search}&quot;.</div>
                )}
                {filteredTables?.map((t) => (
                    <button
                        key={t.name}
                        onClick={() => onSelectTable(t.name)}
                        className={cn(
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60",
                            selectedTable === t.name && "bg-accent/15 text-accent"
                        )}
                    >
                        <Table2 size={14} className="shrink-0 text-muted-foreground" />
                        <span className="truncate">{t.name}</span>
                        {t.estimatedRowCount !== undefined && (
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                {formatCount(t.estimatedRowCount)}
                            </span>
                        )}
                        <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
                    </button>
                ))}
            </div>
        </div>
    );
}

function formatCount(n: number): string {
    if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
