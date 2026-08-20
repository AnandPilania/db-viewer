import { Modal } from "@/components/ui/modal";

interface Shortcut {
  keys: string;
  description: string;
}

const GROUPS: { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: "Global",
    shortcuts: [
      { keys: "Ctrl/⌘ K", description: "Open command palette" },
      { keys: "?", description: "Show this help" },
      { keys: "Esc", description: "Close dialog or menu" },
    ],
  },
  {
    title: "Data grid",
    shortcuts: [
      { keys: "Arrow keys", description: "Move between cells" },
      { keys: "Enter", description: "Edit focused cell" },
      { keys: "Esc", description: "Cancel edit" },
      { keys: "Delete", description: "Delete focused row" },
    ],
  },
  {
    title: "SQL editor",
    shortcuts: [{ keys: "Ctrl/⌘ Enter", description: "Run query" }],
  },
];

export function KeyboardShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} labelledBy="shortcuts-help-title" className="w-full max-w-md">
      <div className="rounded-lg border border-border bg-card p-4 shadow-2xl">
        <h2 id="shortcuts-help-title" className="mb-3 text-sm font-medium">
          Keyboard shortcuts
        </h2>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.shortcuts.map((s) => (
                  <div key={s.keys} className="flex items-center justify-between text-xs">
                    <span className="text-foreground/90">{s.description}</span>
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
