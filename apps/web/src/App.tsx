import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { localPrefs } from "@/lib/local-prefs";
import { SchemaSidebar } from "@/components/SchemaSidebar";
import { ConnectionsPicker } from "@/components/ConnectionsPicker";
import { ConnectionSwitcher } from "@/components/ConnectionSwitcher";
import { TableBrowser } from "@/components/TableBrowser";
import { QueryEditor } from "@/components/QueryEditor";
import { cn } from "@/lib/utils";

type View = "data" | "query";

export function App() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [view, setView] = useState<View>("data");
  const [bootstrapped, setBootstrapped] = useState(false);

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: api.listConnections,
  });

  // On first load, restore whichever connection was last active — otherwise
  // a plain page refresh dumps you back to "no connection" even though the
  // server still has it saved.
  useEffect(() => {
    if (bootstrapped || connectionsLoading) return;
    const lastId = localPrefs.getLastConnectionId();
    if (lastId && connections?.some((c) => c.id === lastId)) {
      setConnectionId(lastId);
    }
    setBootstrapped(true);
  }, [bootstrapped, connectionsLoading, connections]);

  function selectConnection(id: string) {
    setConnectionId(id);
    setSelectedTable(null);
    localPrefs.setLastConnectionId(id);
  }

  function goToPicker() {
    setConnectionId(null);
    localPrefs.setLastConnectionId(null);
  }

  if (!bootstrapped) {
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
  }

  if (!connectionId) {
    return <ConnectionsPicker onSelect={selectConnection} />;
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-4 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Database size={16} className="text-accent" />
          DB Viewer
        </div>

        <ConnectionSwitcher activeConnectionId={connectionId} onSwitch={selectConnection} onAddNew={goToPicker} />

        <div className="flex gap-1 rounded-md bg-muted p-1 text-xs">
          <button
            onClick={() => setView("data")}
            className={cn("rounded px-3 py-1", view === "data" && "bg-accent text-accent-foreground")}
          >
            Data
          </button>
          <button
            onClick={() => setView("query")}
            className={cn("flex items-center gap-1 rounded px-3 py-1", view === "query" && "bg-accent text-accent-foreground")}
          >
            <Terminal size={12} /> SQL
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <SchemaSidebar connectionId={connectionId} selectedTable={selectedTable} onSelectTable={setSelectedTable} />
        <div className="flex-1 overflow-hidden">
          {view === "query" ? (
            <QueryEditor connectionId={connectionId} />
          ) : selectedTable ? (
            <TableBrowser connectionId={connectionId} table={selectedTable} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a table from the sidebar to browse its data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
