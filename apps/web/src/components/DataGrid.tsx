import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ColumnDefinition } from "@db-viewer/driver-interface";
import { cn } from "@/lib/utils";

interface Props {
  columns: ColumnDefinition[];
  rows: Record<string, unknown>[];
  loading: boolean;
  hasMore: boolean;
  onNeedMore: () => void;
  onEditCell?: (rowIndex: number, column: string, value: unknown) => void;
}

const ROW_HEIGHT = 32;
const FETCH_THRESHOLD_PX = 600;

export function DataGrid({ columns, rows, loading, hasMore, onNeedMore }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const tableColumns: ColumnDef<Record<string, unknown>>[] = columns.map((col) => ({
    accessorKey: col.name,
    header: col.name,
    cell: (info) => formatCell(info.getValue()),
  }));

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Infinite scroll: request the next keyset page as the user nears the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (loading || !hasMore) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < FETCH_THRESHOLD_PX) onNeedMore();
    };
    el.addEventListener("scroll", onScroll);
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [loading, hasMore, onNeedMore, tableRows.length]);

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="whitespace-nowrap border-b border-r border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td style={{ height: paddingTop }} colSpan={columns.length} />
              </tr>
            )}
            {virtualItems.map((vi) => {
              const row = tableRows[vi.index];
              return (
                <tr
                  key={row.id}
                  className={cn("hover:bg-muted/40", vi.index % 2 === 1 && "bg-card/40")}
                  style={{ height: ROW_HEIGHT }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="whitespace-nowrap border-r border-border/60 px-3 py-1 font-mono text-xs text-foreground/90"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: paddingBottom }} colSpan={columns.length} />
              </tr>
            )}
          </tbody>
        </table>
        {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading more rows…</div>}
        {!hasMore && rows.length > 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">End of table — {rows.length.toLocaleString()} rows loaded.</div>
        )}
      </div>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
