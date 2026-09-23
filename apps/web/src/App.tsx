import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Terminal, Network, Search, Keyboard } from "lucide-react";
import { api } from "@/lib/api";
import { localPrefs } from "@/lib/local-prefs";
import { SchemaSidebar } from "@/components/SchemaSidebar";
import { ConnectionsPicker } from "@/components/ConnectionsPicker";
import { ConnectionSwitcher } from "@/components/ConnectionSwitcher";
import { TableBrowser } from "@/components/TableBrowser";
import { CommandPalette, type Command } from "@/components/CommandPalette";
import { KeyboardShortcutsHelp } from "@/components/KeyboardShortcutsHelp";
import { cn } from "@/lib/utils";
import { getNavViews } from "@/lib/navViews";
import { setDrillHandler, type DrillTarget } from "@/lib/drillNav";
import { parseLocation, buildPath, DEFAULT_VIEW } from "@/lib/appRoute";
import type { FilterNode } from "@pilaniaanand/driver-interface";

const QueryEditor = lazy(() => import("@/components/QueryEditor").then((m) => ({ default: m.QueryEditor })));
const ERDiagram = lazy(() => import("@/components/ERDiagram").then((m) => ({ default: m.ERDiagram })));

type View = "data" | "query" | "erd";

const VIEWS: { id: View; label: string; icon: typeof Terminal }[] = [
    { id: "data", label: "Data", icon: Database },
    { id: "query", label: "SQL", icon: Terminal },
    { id: "erd", label: "ER Diagram", icon: Network },
];

export function App() {
    const [connectionId, setConnectionId] = useState<string | null>(null);
    const [selectedTable, setSelectedTable] = useState<string | null>(null);
    const [initialFilter, setInitialFilter] = useState<FilterNode | null>(null);
    const [view, setView] = useState<View | string>(DEFAULT_VIEW);
    // Sub-resource id for a module nav view (e.g. an open dashboard's id) —
    // the "data" view's equivalent slot is selectedTable instead, since only
    // one of the two is ever relevant for the active view.
    const [navDetail, setNavDetail] = useState<string | null>(null);
    const [bootstrapped, setBootstrapped] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);

    // The dashboards module's drill-to-detail (B3) navigates here through this
    // one callback — see lib/drillNav.ts for why this is a plain module-level
    // handler rather than a prop: the module's install() runs once at boot,
    // long before this component (or its state setters) exist.
    useEffect(() => {
        setDrillHandler((target: DrillTarget) => {
            setConnectionId(target.connectionId);
            setSelectedTable(target.table);
            // A bar/pie group for a NULL x-value clicks through with value
            // null — "= NULL" matches nothing in SQL, so that group needs
            // "is_null" instead.
            setInitialFilter(
                target.value == null
                    ? { column: target.column, op: "is_null" }
                    : { column: target.column, op: "=", value: target.value }
            );
            setView(DEFAULT_VIEW);
        });
        return () => setDrillHandler(() => {});
    }, []);

    const { data: connections, isLoading: connectionsLoading } = useQuery({
        queryKey: ["connections"],
        queryFn: api.listConnections,
    });

    const { data: tables } = useQuery({
        queryKey: ["tables", connectionId],
        queryFn: () => api.listTables(connectionId!),
        enabled: !!connectionId && view === "data",
    });

    // On first load, restore whichever connection/view/table the URL names —
    // or, for a bare "/", whichever connection was last active, so a plain
    // page refresh there doesn't dump you back to "no connection" even though
    // the server still has it saved.
    useEffect(() => {
        if (bootstrapped || connectionsLoading) return;
        const fromUrl = parseLocation(window.location.pathname);
        const id = fromUrl.connectionId ?? localPrefs.getLastConnectionId();
        if (id && connections?.some((c) => c.id === id)) {
            // Synchronizing with the connections query resolving (an external async
            // source), not deriving state from a prop — a legitimate effect, not the
            // "adjust state on prop change" case react-hooks/set-state-in-effect targets.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setConnectionId(id);
            if (fromUrl.connectionId === id) {
                setView(fromUrl.view);
                if (fromUrl.view === DEFAULT_VIEW) setSelectedTable(fromUrl.detail);
                else setNavDetail(fromUrl.detail);
            }
        }
        setBootstrapped(true);
    }, [bootstrapped, connectionsLoading, connections]);

    // Keeps the URL in step with (connectionId, view, detail) — the first
    // sync after bootstrap replaces the entry (a page load shouldn't grow the
    // back-stack), every one after that pushes, so browser back/forward move
    // between tables/dashboards/views/connections like any other page.
    const didInitialUrlSync = useRef(false);
    useEffect(() => {
        if (!bootstrapped) return;
        const detail = view === DEFAULT_VIEW ? selectedTable : navDetail;
        const path = buildPath({ connectionId, view, detail });
        if (path !== window.location.pathname) {
            if (didInitialUrlSync.current) window.history.pushState(null, "", path);
            else window.history.replaceState(null, "", path);
        }
        didInitialUrlSync.current = true;
    }, [bootstrapped, connectionId, view, selectedTable, navDetail]);

    // Browser back/forward: apply the URL's state directly rather than going
    // through selectConnection/selectTable, whose extra resets (clearing
    // initialFilter, etc.) aren't wanted here — the target state IS the URL.
    useEffect(() => {
        function onPopState() {
            const route = parseLocation(window.location.pathname);
            if (route.connectionId && connections?.some((c) => c.id === route.connectionId)) {
                setConnectionId(route.connectionId);
                setView(route.view);
                if (route.view === DEFAULT_VIEW) {
                    setSelectedTable(route.detail);
                    setNavDetail(null);
                } else {
                    setSelectedTable(null);
                    setNavDetail(route.detail);
                }
                localPrefs.setLastConnectionId(route.connectionId);
            } else {
                setConnectionId(null);
            }
        }
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, [connections]);

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
        setInitialFilter(null);
        localPrefs.setLastConnectionId(id);
    }

    function selectTable(name: string) {
        setSelectedTable(name);
        setInitialFilter(null);
    }

    // Switches the active tab/nav-item and resets its detail to a fresh
    // landing page — clearing selectedTable too when moving into a nav view,
    // so it can't leak into that view's detail slot in the URL (they share
    // the same path segment; see appRoute.ts).
    function switchView(id: string) {
        setView(id);
        setNavDetail(null);
        if (getNavViews().some((v) => v.id === id)) setSelectedTable(null);
    }

    function goToPicker() {
        setConnectionId(null);
        // Deliberately not clearing localPrefs' last-connection-id here: it's what
        // lets the picker's back arrow (below) return to this session.
    }

    const commands: Command[] = useMemo(() => {
        const cmds: Command[] = [];

        for (const v of VIEWS) {
            cmds.push({ id: `view-${v.id}`, group: "Go to", label: v.label, onRun: () => switchView(v.id) });
        }
        for (const v of getNavViews()) {
            cmds.push({ id: `view-${v.id}`, group: "Go to", label: v.label, onRun: () => switchView(v.id) });
        }

        if (connectionId && view === "data" && tables) {
            for (const t of tables) {
                cmds.push({
                    id: `table-${t.name}`,
                    group: "Tables",
                    label: t.name,
                    onRun: () => selectTable(t.name),
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
        cmds.push({
            id: "shortcuts",
            group: "Help",
            label: "Keyboard shortcuts",
            shortcut: "?",
            onRun: () => setHelpOpen(true),
        });

        return cmds;
    }, [connectionId, view, tables, connections]);

    if (!bootstrapped) {
        return (
            <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
                Loading…
            </div>
        );
    }

    if (!connectionId) {
        const lastId = localPrefs.getLastConnectionId();
        const canGoBack = !!lastId && connections?.some((c) => c.id === lastId);
        return (
            <>
                <ConnectionsPicker
                    onSelect={selectConnection}
                    onBack={canGoBack ? () => selectConnection(lastId!) : undefined}
                />
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

                <ConnectionSwitcher
                    activeConnectionId={connectionId}
                    onSwitch={selectConnection}
                    onAddNew={goToPicker}
                />

                <nav aria-label="Views" className="flex gap-1 rounded-md bg-muted p-1 text-xs">
                    {VIEWS.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => switchView(v.id)}
                            aria-current={view === v.id ? "page" : undefined}
                            className={cn(
                                "flex items-center gap-1 rounded px-3 py-1",
                                view === v.id && "bg-accent text-accent-foreground"
                            )}
                        >
                            <v.icon size={12} /> {v.label}
                        </button>
                    ))}
                    {getNavViews().map((v) => (
                        <button
                            key={v.id}
                            onClick={() => switchView(v.id)}
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
                {!getNavViews().some((v) => v.id === view) && (
                    <SchemaSidebar
                        connectionId={connectionId}
                        selectedTable={selectedTable}
                        onSelectTable={selectTable}
                    />
                )}
                <div className="flex-1 overflow-hidden">
                    {view === "query" ? (
                        <Suspense
                            fallback={
                                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                    Loading editor…
                                </div>
                            }
                        >
                            <QueryEditor
                                connectionId={connectionId}
                                driver={connections?.find((c) => c.id === connectionId)?.driver ?? ""}
                            />
                        </Suspense>
                    ) : view === "erd" ? (
                        <Suspense
                            fallback={
                                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                    Loading…
                                </div>
                            }
                        >
                            <ERDiagram connectionId={connectionId} />
                        </Suspense>
                    ) : getNavViews().find((v) => v.id === view) ? (
                        getNavViews()
                            .find((v) => v.id === view)!
                            .render({ detail: navDetail, onDetailChange: setNavDetail })
                    ) : selectedTable ? (
                        <TableBrowser connectionId={connectionId} table={selectedTable} initialFilter={initialFilter} />
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
