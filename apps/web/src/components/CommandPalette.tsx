import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

export interface Command {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  onRun: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function run(cmd: Command) {
    onClose();
    cmd.onRun();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIndex]) run(filtered[activeIndex]);
    }
  }

  let lastGroup = "";

  return (
    <Modal onClose={onClose} labelledBy="command-palette-label" className="w-full max-w-lg">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-2xl" onKeyDown={onKeyDown}>
        <span id="command-palette-label" className="sr-only">
          Command palette
        </span>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[activeIndex] ? `cmd-${filtered[activeIndex].id}` : undefined}
            className="h-6 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted-foreground">No matching commands</div>}
          {filtered.map((cmd, i) => {
            const showGroupHeader = cmd.group !== lastGroup;
            lastGroup = cmd.group;
            return (
              <div key={cmd.id}>
                {showGroupHeader && (
                  <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {cmd.group}
                  </div>
                )}
                <button
                  id={`cmd-${cmd.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => run(cmd)}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm",
                    i === activeIndex ? "bg-accent/15 text-accent" : "text-foreground/90"
                  )}
                >
                  <span className="truncate">{cmd.label}</span>
                  {cmd.shortcut && <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{cmd.shortcut}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
