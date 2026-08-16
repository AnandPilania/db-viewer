import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnDefinition } from "@db-viewer/driver-interface";
import { api } from "@/lib/api";
import type { RowChangeEvent } from "@/hooks/useTableRealtime";

const PAGE_SIZE = 200;

export function useTableRows(connectionId: string | null, table: string | null, schema?: string) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const columnsRef = useRef<ColumnDefinition[]>([]);
  columnsRef.current = columns;

  const reset = useCallback(() => {
    setRows([]);
    setColumns([]);
    cursorRef.current = null;
    setHasMore(true);
    setError(null);
  }, []);

  useEffect(() => {
    reset();
  }, [connectionId, table, schema, reset]);

  const loadMore = useCallback(async () => {
    if (!connectionId || !table || loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await api.queryRows(connectionId, table, {
        schema,
        pageSize: PAGE_SIZE,
        afterCursor: cursorRef.current,
      });
      setRows((prev) => [...prev, ...page.rows]);
      setColumns((prev) => (prev.length ? prev : page.columns));
      cursorRef.current = page.nextCursor;
      setHasMore(page.nextCursor !== null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [connectionId, table, schema, hasMore]);

  // Kick off first page whenever the target resets.
  useEffect(() => {
    if (connectionId && table) loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, table, schema]);

  const updateLocalCell = useCallback((rowIndex: number, column: string, value: unknown) => {
    setRows((prev) => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], [column]: value };
      return next;
    });
  }, []);

  const prependRow = useCallback((row: Record<string, unknown>) => {
    setRows((prev) => [row, ...prev]);
  }, []);

  const removeLocalRowAt = useCallback((rowIndex: number) => {
    setRows((prev) => prev.filter((_, i) => i !== rowIndex));
  }, []);

  /**
   * Applies a realtime change event idempotently — safe to call even for
   * an event this same client just caused via its own optimistic update
   * (matching by primary key rather than array position, so a duplicate
   * apply is a harmless no-op rather than a double-edit).
   */
  const applyChangeEvent = useCallback((event: RowChangeEvent) => {
    const pkCols = columnsRef.current.filter((c) => c.isPrimaryKey).map((c) => c.name);
    if (pkCols.length === 0) return; // can't safely match rows without a known primary key

    const matches = (row: Record<string, unknown>, pk: Record<string, unknown>) =>
      pkCols.every((c) => c in pk && String(row[c]) === String(pk[c]));

    setRows((prev) => {
      if (event.type === "insert" && event.row) {
        if (prev.some((r) => matches(r, event.row!))) return prev;
        return [event.row, ...prev];
      }
      if (event.type === "update" && event.primaryKey) {
        // MongoDB's change-stream path sends whole-document replacements
        // (column "__row__") rather than a single field patch.
        if (event.column === "__row__" && event.value && typeof event.value === "object") {
          return prev.map((r) => (matches(r, event.primaryKey!) ? (event.value as Record<string, unknown>) : r));
        }
        if (event.column) {
          return prev.map((r) => (matches(r, event.primaryKey!) ? { ...r, [event.column!]: event.value } : r));
        }
      }
      if (event.type === "delete" && event.primaryKey) {
        return prev.filter((r) => !matches(r, event.primaryKey!));
      }
      return prev;
    });
  }, []);

  return {
    rows,
    columns,
    loading,
    hasMore,
    error,
    loadMore,
    reset,
    updateLocalCell,
    prependRow,
    removeLocalRowAt,
    applyChangeEvent,
  };
}
