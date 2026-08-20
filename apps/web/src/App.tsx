import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Terminal, Network, LayoutGrid, Search, Keyboard } from "lucide-react";
import { api } from "@/lib/api";
import { localPrefs } from "@/lib/local-prefs";
import { SchemaSidebar } from "@/components/SchemaSidebar";
import { ConnectionsPicker } from "@/components/ConnectionsPicker";
import { ConnectionSwitcher } from "@/components/ConnectionSwitcher";
import { TableBrowser } from "@/components/TableBrowser";
import { CommandPalette, type Command } from "@/components/CommandPalette";
import { KeyboardShortcutsHelp } from "@/components/KeyboardShortcutsHelp";
import { cn } from "@/lib/utils";

const QueryEditor = lazy(() => import("@/components/QueryEditor").then((m) => ({ default: m.QueryEditor })));
const ERDiagram = lazy(() => import("@/components/ERDiagram").then((m) => ({ default: m.ERDiagram })));
const DashboardsPage = lazy(() => import("@/components/DashboardsPage").then((m) => ({ default: m.DashboardsPage })));

type View = "data" | "query" | "erd" | "dashboards";

const VIEWS: { id: View; label: string; icon: typeof Terminal }[] = [
  { id: "data", label: "Data", icon: Database },
  { id: "query", label: "SQL", icon: Terminal },
  { id: "erd", label: "ER Diagram", icon: Network },
  { id: "dashboards", label: "Dashboards", icon: LayoutGrid },
];

export function App() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [view, setView] = useState<View>("data");
  const [bootstrapped, setBootstrapped] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: api.listConnections,
  });

  const { data: tables } = useQuery({
    queryKey: ["tables", connectionId],
    queryFn: () => api.listTables(connectionId!),
    enabled: !!connectionId && view === "data",
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

  // Global keyboard shortcuts. Ctrl/Cmd+K always works (standard command-
  // palette convention, even mid-typing); "?" only fires outside text
  // inputs since it's a normal typable character everywhere else.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === "?") {
        const target = e.target as HTMLElement;
        const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
        if (!typing) {
          e.preventDefault();
          setHelpOpen(true);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function selectConnection(id: string) {
    setConnectionId(id);
    setSelectedTable(null);
    localPrefs.setLastConnectionId(id);
  }

  function goToPicker() {
    setConnectionId(null);
    localPrefs.setLastConnectionId(null);
  }

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];

    for (const v of VIEWS) {
      cmds.push({ id: `view-${v.id}`, group: "Go to", label: v.label, onRun: () => setView(v.id) });
    }

    if (connectionId && view === "data" && tables) {
      for (const t of tables) {
        cmds.push({
          id: `table-${t.name}`,
          group: "Tables",
          label: t.name,
          onRun: () => setSelectedTable(t.name),
        });
      }
    }

    if (connections) {
      for (const c of connections) {
        if (c.id === connectionId) continue;
        cmds.push({
          id: `conn-${c.id}`,
          group: "Switch connection",
          label: `${c.driver}: ${c.database || c.filePath || c.host || c.id}`,
          onRun: () => selectConnection(c.id),
        });
      }
    }

    cmds.push({ id: "new-connection", group: "Connections", label: "Add new connection", onRun: goToPicker });
    cmds.push({ id: "shortcuts", group: "Help", label: "Keyboard shortcuts", shortcut: "?", onRun: () => setHelpOpen(true) });

    return cmds;
  }, [connectionId, view, tables, connections]);

  if (!bootstrapped) {
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
  }

  if (!connectionId) {
    return (
      <>
        <ConnectionsPicker onSelect={selectConnection} />
        {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
        {helpOpen && <KeyboardShortcutsHelp onClose={() => setHelpOpen(false)} />}
      </>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-4 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Database size={16} className="text-accent" />
          DB Viewer
        </div>

        <ConnectionSwitcher activeConnectionId={connectionId} onSwitch={selectConnection} onAddNew={goToPicker} />

        <nav aria-label="Views" className="flex gap-1 rounded-md bg-muted p-1 text-xs">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-current={view === v.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-1 rounded px-3 py-1",
                view === v.id && "bg-accent text-accent-foreground"
              )}
            >
              <v.icon size={12} /> {v.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            <Search size={12} />
            <span className="hidden sm:inline">Search</span>
            <kbd className="ml-1 rounded border border-border bg-card px-1 text-[10px]">⌘K</kbd>
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            aria-label="Show keyboard shortcuts"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Keyboard size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {view !== "dashboards" && (
          <SchemaSidebar connectionId={connectionId} selectedTable={selectedTable} onSelectTable={setSelectedTable} />
        )}
        <div className="flex-1 overflow-hidden">
          {view === "query" ? (
            <Suspense
              fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading editor…</div>}
            >
              <QueryEditor connectionId={connectionId} driver={connections?.find((c) => c.id === connectionId)?.driver ?? ""} />
            </Suspense>
          ) : view === "erd" ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
              <ERDiagram connectionId={connectionId} />
            </Suspense>
          ) : view === "dashboards" ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
              <DashboardsPage />
            </Suspense>
          ) : selectedTable ? (
            <TableBrowser connectionId={connectionId} table={selectedTable} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a table from the sidebar to browse its data.
            </div>
          )}
        </div>
      </div>

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <KeyboardShortcutsHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
