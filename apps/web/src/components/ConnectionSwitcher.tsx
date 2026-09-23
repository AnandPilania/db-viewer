import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plug, Plus, Search } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface Props {
    activeConnectionId: string;
    onSwitch: (id: string) => void;
    onAddNew: () => void;
}

export function ConnectionSwitcher({ activeConnectionId, onSwitch, onAddNew }: Props) {
    const { data: connections } = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const ref = useRef<HTMLDivElement>(null);

    // Fresh search each time the menu closes, rather than leaving the last
    // query in place next open — adjusted during render (this codebase's
    // pattern for resetting state on a prop/condition change) rather than in
    // an effect, so there's no extra frame showing the stale query.
    const [prevOpen, setPrevOpen] = useState(open);
    if (prevOpen !== open) {
        setPrevOpen(open);
        if (!open) setSearch("");
    }

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    const active = connections?.find((c) => c.id === activeConnectionId);

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Active connection: ${active?.database || active?.filePath || active?.host || "none"}. Click to switch.`}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
                <Plug size={12} className="text-accent" />
                <span className="max-w-[160px] truncate">
                    {active?.database || active?.filePath || active?.host || "…"}
                </span>
                <ChevronDown size={12} />
            </button>

            {open && (
                <div
                    role="menu"
                    className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-border bg-card shadow-lg"
                >
                    {connections && connections.length > 5 && (
                        <div className="relative border-b border-border p-1.5">
                            <Search
                                size={12}
                                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
                            />
                            <Input
                                autoFocus
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search…"
                                className="h-7 pl-7 text-xs"
                            />
                        </div>
                    )}
                    {connections
                        ?.filter((c) =>
                            [c.database || c.filePath || c.host || c.id, c.driver]
                                .join(" ")
                                .toLowerCase()
                                .includes(search.trim().toLowerCase())
                        )
                        .map((c) => (
                            <button
                                key={c.id}
                                role="menuitemradio"
                                aria-checked={c.id === activeConnectionId}
                                onClick={() => {
                                    onSwitch(c.id);
                                    setOpen(false);
                                }}
                                className={cn(
                                    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/60",
                                    c.id === activeConnectionId && "bg-accent/15 text-accent"
                                )}
                            >
                                <Plug size={12} className="shrink-0" />
                                <div className="min-w-0">
                                    <div className="truncate">{c.database || c.filePath || c.host || c.id}</div>
                                    <div className="truncate text-muted-foreground">{c.driver}</div>
                                </div>
                            </button>
                        ))}
                    <button
                        role="menuitem"
                        onClick={() => {
                            onAddNew();
                            setOpen(false);
                        }}
                        className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-accent hover:bg-muted/60"
                    >
                        <Plus size={12} /> New connection
                    </button>
                </div>
            )}
        </div>
    );
}
