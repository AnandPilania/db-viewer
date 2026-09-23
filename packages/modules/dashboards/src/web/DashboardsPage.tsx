import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Plus, Search, Trash2 } from "lucide-react";
import { dashboardApi, type Dashboard } from "./api.js";
import { DashboardBuilder, type DrillTarget } from "./DashboardBuilder.js";
import { Button, Input, Toaster, toast } from "./ui.js";

const UNGROUPED = "Ungrouped";

/** Folder, then title — matches how the grouped view lists them. */
function groupByFolder(dashboards: Dashboard[]): [string, Dashboard[]][] {
    const groups = new Map<string, Dashboard[]>();
    for (const d of dashboards) {
        const key = d.folder || UNGROUPED;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(d);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));
}

interface Props {
    onDrillToTable?: (target: DrillTarget) => void;
    /** Open dashboard id from the host app's URL, e.g. after a browser back/forward. */
    detail?: string | null;
    /** Reports the open dashboard id (or null, back at the list) so the host app can reflect it in the URL. */
    onDetailChange?: (detail: string | null) => void;
}

export function DashboardsPage({ onDrillToTable, detail = null, onDetailChange }: Props = {}) {
    const [openId, setOpenIdState] = useState<string | null>(detail);
    const [newTitle, setNewTitle] = useState("");
    const [newFolder, setNewFolder] = useState("");
    const [search, setSearch] = useState("");
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [folderDraft, setFolderDraft] = useState("");
    const queryClient = useQueryClient();

    // Follows `detail` when it changes from outside (host app popstate handling
    // on browser back/forward) — React's documented "adjust state on prop
    // change" pattern, not an effect, so there's no extra frame showing the
    // stale dashboard.
    const [prevDetail, setPrevDetail] = useState(detail);
    if (prevDetail !== detail) {
        setPrevDetail(detail);
        setOpenIdState(detail);
    }

    function setOpenId(id: string | null) {
        setOpenIdState(id);
        onDetailChange?.(id);
    }

    const { data: dashboards } = useQuery({ queryKey: ["dashboards"], queryFn: dashboardApi.listDashboards });

    const createMutation = useMutation({
        mutationFn: async (title: string) => {
            const dashboard = await dashboardApi.createDashboard(title);
            return newFolder.trim()
                ? dashboardApi.updateDashboard(dashboard.id, { folder: newFolder.trim() })
                : dashboard;
        },
        onSuccess: (dashboard) => {
            queryClient.invalidateQueries({ queryKey: ["dashboards"] });
            setNewTitle("");
            setOpenId(dashboard.id);
        },
        onError: (err) => toast.error((err as Error).message),
    });

    const [deletingId, setDeletingId] = useState<string | null>(null);
    const deleteMutation = useMutation({
        mutationFn: (id: string) => dashboardApi.deleteDashboard(id),
        onMutate: (id) => setDeletingId(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
        onError: (err) => toast.error((err as Error).message),
        onSettled: () => setDeletingId(null),
    });

    const folderMutation = useMutation({
        mutationFn: ({ id, folder }: { id: string; folder: string }) => dashboardApi.updateDashboard(id, { folder }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
        onError: (err) => toast.error((err as Error).message),
        onSettled: () => setEditingFolderId(null),
    });

    if (openId) {
        return <DashboardBuilder dashboardId={openId} onBack={() => setOpenId(null)} onDrillToTable={onDrillToTable} />;
    }

    return (
        <div className="flex h-full flex-col">
            <Toaster />
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <LayoutGrid size={16} className="text-accent" />
                <span className="text-sm font-medium">Dashboards</span>
                <div className="relative">
                    <Search
                        size={12}
                        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search…"
                        className="h-8 w-40 pl-7"
                    />
                </div>
                <div className="ml-auto flex items-center gap-2">
                    <Input
                        value={newFolder}
                        onChange={(e) => setNewFolder(e.target.value)}
                        placeholder="Folder (optional)"
                        className="h-8 w-32"
                    />
                    <Input
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        placeholder="New dashboard title"
                        className="h-8 w-56"
                        onKeyDown={(e) =>
                            e.key === "Enter" && newTitle.trim() && createMutation.mutate(newTitle.trim())
                        }
                    />
                    <Button
                        size="sm"
                        onClick={() => newTitle.trim() && createMutation.mutate(newTitle.trim())}
                        disabled={createMutation.isPending}
                    >
                        <Plus size={12} /> {createMutation.isPending ? "Creating…" : "Create"}
                    </Button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-3">
                {!dashboards || dashboards.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        No dashboards yet — create one above.
                    </div>
                ) : (
                    (() => {
                        const filtered = dashboards.filter((d) =>
                            d.title.toLowerCase().includes(search.trim().toLowerCase())
                        );
                        if (filtered.length === 0) {
                            return (
                                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                    No dashboards match &quot;{search}&quot;.
                                </div>
                            );
                        }
                        return (
                            <div className="space-y-4">
                                {groupByFolder(filtered).map(([folder, group]) => (
                                    <div key={folder}>
                                        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                            {folder}
                                        </div>
                                        <div className="grid grid-cols-3 gap-3">
                                            {group.map((d) => (
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
                                                            disabled={deletingId === d.id}
                                                            aria-label={`Delete dashboard "${d.title}"`}
                                                            className="text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-100"
                                                        >
                                                            <Trash2
                                                                size={14}
                                                                className={
                                                                    deletingId === d.id ? "animate-spin" : undefined
                                                                }
                                                            />
                                                        </button>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {d.layout.length} widget{d.layout.length === 1 ? "" : "s"}
                                                        {d.embedEnabled && " · embed enabled"}
                                                    </div>
                                                    {editingFolderId === d.id ? (
                                                        <Input
                                                            autoFocus
                                                            value={folderDraft}
                                                            onClick={(e) => e.stopPropagation()}
                                                            onChange={(e) => setFolderDraft(e.target.value)}
                                                            onBlur={() =>
                                                                folderMutation.mutate({ id: d.id, folder: folderDraft })
                                                            }
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter")
                                                                    (e.target as HTMLInputElement).blur();
                                                                if (e.key === "Escape") setEditingFolderId(null);
                                                            }}
                                                            placeholder="Folder"
                                                            className="mt-1.5 h-6 text-xs"
                                                        />
                                                    ) : (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setFolderDraft(d.folder ?? "");
                                                                setEditingFolderId(d.id);
                                                            }}
                                                            className="mt-1.5 self-start text-[11px] text-muted-foreground underline decoration-dotted opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                                        >
                                                            {d.folder ? `Move from "${d.folder}"` : "Add to folder"}
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        );
                    })()
                )}
            </div>
        </div>
    );
}
