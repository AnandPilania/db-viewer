import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnDefinition } from "@db-viewer/driver-interface";
import { api } from "@/lib/api";

const PAGE_SIZE = 200;

export function useTableRows(connectionId: string | null, table: string | null, schema?: string) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

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

  return { rows, columns, loading, hasMore, error, loadMore, reset };
}
