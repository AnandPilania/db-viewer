import { Handle, Position } from "reactflow";
import { KeyRound, Link2 } from "lucide-react";
import type { TableDefinition } from "@pilaniaanand/driver-interface";

export function TableNode({ data }: { data: TableDefinition }) {
  return (
    <div className="w-64 overflow-hidden rounded-md border border-border bg-card shadow-lg">
      <div className="border-b border-border bg-muted/60 px-3 py-1.5 text-xs font-semibold">{data.name}</div>
      <div className="max-h-64 overflow-y-auto">
        {data.columns.map((col) => (
          <div
            key={col.name}
            className="relative flex items-center gap-1.5 border-b border-border/40 px-3 py-1 text-[11px] last:border-b-0"
          >
            {col.isPrimaryKey && <KeyRound size={10} className="shrink-0 text-accent" />}
            {col.isForeignKey && !col.isPrimaryKey && <Link2 size={10} className="shrink-0 text-muted-foreground" />}
            <span className={col.isPrimaryKey ? "font-medium text-accent" : "text-foreground/90"}>{col.name}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{col.nativeType || col.type}</span>

            {/* Connection points for FK edges — one per column keeps edges pointing at the right row */}
            <Handle
              type="target"
              position={Position.Left}
              id={col.name}
              className="!h-1.5 !w-1.5 !border-0 !bg-accent/60"
            />
            <Handle
              type="source"
              position={Position.Right}
              id={col.name}
              className="!h-1.5 !w-1.5 !border-0 !bg-accent/60"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
