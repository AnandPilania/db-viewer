import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDefinition, FilterNode } from "@pilaniaanand/driver-interface";
import { api } from "@/lib/api";
import { applyRowChange } from "@/lib/apply-row-change";
import type { RowChangeEvent } from "@/hooks/useTableRealtime";

const PAGE_SIZE = 200;

/**
 * How many pages stay resident. Pages beyond this are dropped from the front
 * as the user scrolls down, which is the whole reason this hook can face a
 * table of any size: the old implementation appended every page into one
 * growing array, so the browser tab died somewhere around a million rows no
 * matter how well the grid virtualized its painting.
 *
 * 100 pages x 200 rows = 20k rows resident. Rows above the window are still
 * reachable — scrolling up refetches them — they just aren't held in memory.
 */
const MAX_PAGES = 100;
const WINDOW_ROWS = MAX_PAGES * PAGE_SIZE;

export interface TableSort {
    column: string;
    direction: "asc" | "desc";
}

/**
 * A position in the table, used as the page param.
 *
 * `cursor` is an opaque driver-issued keyset cursor (continue after a known
 * row). `seek` is a sort-key value the user asked to jump to, which the
 * driver resolves to an index position — this is what makes "go to row ~800
 * billion" possible without an OFFSET scan. `index` is the page's ordinal
 * from the current anchor, used to label absolute row numbers in the UI.
 */
interface PageParam {
    cursor: string | null;
    seek: unknown[] | null;
    index: number;
}

const FIRST_PAGE: PageParam = { cursor: null, seek: null, index: 0 };

export function useTableRows(
    connectionId: string | null,
    table: string | null,
    schema?: string,
    /** Seeds the filter state once, e.g. drill-to-detail (B3) landing on a table pre-filtered to one column/value. */
    initialFilter?: FilterNode | null
) {
    const queryClient = useQueryClient();
    const [sort, setSort] = useState<TableSort | null>(null);
    const [filters, setFilters] = useState<FilterNode[]>(initialFilter ? [initialFilter] : []);
    /** Non-null once the user has jumped; the window's rows start at an unknown absolute offset. */
    const [anchor, setAnchor] = useState<{ seek: unknown[]; label: string } | null>(null);
    const [localRows, setLocalRows] = useState<Record<string, unknown>[] | null>(null);

    const queryKey = useMemo(
        () => ["table-rows", connectionId, schema ?? null, table, sort, filters, anchor?.seek ?? null] as const,
        [connectionId, schema, table, sort, filters, anchor]
    );

    const query = useInfiniteQuery({
        queryKey,
        enabled: !!connectionId && !!table,
        initialPageParam: anchor ? { cursor: null, seek: anchor.seek, index: 0 } : FIRST_PAGE,
        queryFn: ({ pageParam, signal }) =>
            api.queryRows(connectionId!, table!, {
                schema,
                pageSize: PAGE_SIZE,
                afterCursor: pageParam.cursor,
                seek: pageParam.seek,
                sort: sort ? [sort] : undefined,
                filters: filters.length ? filters : undefined,
                signal,
            }),
        getNextPageParam: (lastPage, _all, lastParam): PageParam | null =>
            lastPage.nextCursor ? { cursor: lastPage.nextCursor, seek: null, index: lastParam.index + 1 } : null,
        // Bounds memory. Dropping from the front is what keeps a long scroll
        // flat instead of linear in rows visited.
        maxPages: MAX_PAGES,
        // Rows are live data behind a realtime channel, not cacheable content
        // — a stale page shown after a table switch is worse than a refetch.
        staleTime: 0,
        gcTime: 30_000,
        retry: 1,
    });

    const fetchedRows = useMemo(() => (query.data ? query.data.pages.flatMap((p) => p.rows) : []), [query.data]);

    // Optimistic edits/inserts/deletes and realtime patches are applied to a
    // local overlay rather than into the query cache, so a background refetch
    // can replace the page without having to reconcile them.
    const rows = localRows ?? fetchedRows;

    const columns: ColumnDefinition[] = query.data?.pages[0]?.columns ?? [];
    const orderBy = query.data?.pages[0]?.orderBy ?? [];
    const columnsRef = useRef<ColumnDefinition[]>(columns);
    // Synced after each commit (not during render) so applyChangeEvent, which
    // reads it from an event-handler callback, always sees the latest value.
    useEffect(() => {
        columnsRef.current = columns;
    });

    // Drop the overlay whenever fresh server data arrives, so it can never
    // outlive the rows it was patching. Adjusted during render (React's
    // documented pattern for resetting state when an input changes) rather
    // than in an effect, so there's no extra frame where the overlay still
    // shows rows from before the new data arrived.
    const [prevFetchedRows, setPrevFetchedRows] = useState(fetchedRows);
    if (prevFetchedRows !== fetchedRows) {
        setPrevFetchedRows(fetchedRows);
        setLocalRows(null);
    }

    // Reset the view — but not the user's sort — when the target changes.
    // Filters do reset: they name columns of the table being left. A new
    // initialFilter re-seeds them instead of clearing to [] — this is what
    // lets a second drill-to-detail click (same table, different value) take
    // effect even though connectionId/table/schema didn't change.
    const filterSeedKey = initialFilter ? JSON.stringify(initialFilter) : null;
    const [prevTarget, setPrevTarget] = useState({ connectionId, table, schema, filterSeedKey });
    if (
        prevTarget.connectionId !== connectionId ||
        prevTarget.table !== table ||
        prevTarget.schema !== schema ||
        prevTarget.filterSeedKey !== filterSeedKey
    ) {
        setPrevTarget({ connectionId, table, schema, filterSeedKey });
        setAnchor(null);
        setLocalRows(null);
        setFilters(initialFilter ? [initialFilter] : []);
    }

    /**
     * The absolute row number of the first resident row. Zero until pages
     * start being dropped from the front; unknown (and reported as such) once
     * the user has jumped to an anchor, since a keyset seek says where a value
     * is, not how many rows precede it.
     */
    // pageParams is typed loosely by react-query's inference here; the params
    // are exactly the PageParam objects getNextPageParam returns.
    const firstPageIndex = (query.data?.pageParams as PageParam[] | undefined)?.[0]?.index ?? 0;
    const windowStartRow = anchor ? null : firstPageIndex * PAGE_SIZE;

    const loadMore = useCallback(() => {
        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    }, [query]);

    /** Jump to the first row at or past `value` on the leading ordering column. */
    const jumpTo = useCallback((value: unknown) => {
        setLocalRows(null);
        setAnchor({ seek: [value], label: String(value) });
    }, []);

    /** Back to the top of the table, clearing any jump anchor. */
    const jumpToStart = useCallback(() => {
        setLocalRows(null);
        setAnchor(null);
    }, []);

    /** Replaces the WHERE clause. Like a sort change, this invalidates any jump anchor. */
    const changeFilters = useCallback((next: FilterNode[]) => {
        setLocalRows(null);
        setAnchor(null);
        setFilters(next);
    }, []);

    const changeSort = useCallback((next: TableSort | null) => {
        setLocalRows(null);
        setAnchor(null); // a jump anchor is a position in the old ordering
        setSort(next);
    }, []);

    const refetchRows = useCallback(() => {
        setLocalRows(null);
        void queryClient.invalidateQueries({ queryKey });
    }, [queryClient, queryKey]);

    const patchRows = useCallback(
        (fn: (current: Record<string, unknown>[]) => Record<string, unknown>[]) => {
            setLocalRows((prev) => fn(prev ?? fetchedRows));
        },
        [fetchedRows]
    );

    const updateLocalCell = useCallback(
        (rowIndex: number, column: string, value: unknown) => {
            patchRows((current) => {
                if (!current[rowIndex]) return current;
                const next = [...current];
                next[rowIndex] = { ...next[rowIndex], [column]: value };
                return next;
            });
        },
        [patchRows]
    );

    const prependRow = useCallback(
        (row: Record<string, unknown>) => patchRows((current) => [row, ...current]),
        [patchRows]
    );

    const removeLocalRowAt = useCallback(
        (rowIndex: number) => patchRows((current) => current.filter((_, i) => i !== rowIndex)),
        [patchRows]
    );

    /**
     * Applies a realtime change event to the local overlay. The matching and
     * merging rules live in applyRowChange (pure, unit-tested) — see there for
     * why events are matched by primary key rather than array position.
     */
    const applyChangeEvent = useCallback(
        (event: RowChangeEvent) => {
            const pkCols = columnsRef.current.filter((c) => c.isPrimaryKey).map((c) => c.name);
            if (pkCols.length === 0) return;
            patchRows((current) => applyRowChange(current, event, pkCols));
        },
        [patchRows]
    );

    return {
        rows,
        columns,
        orderBy,
        sort,
        changeSort,
        filters,
        changeFilters,
        /** True while the first page of a new target/sort/anchor is loading — the grid shows a skeleton, not an empty table. */
        initialLoading: query.isPending && !!connectionId && !!table,
        loading: query.isFetching,
        loadingMore: query.isFetchingNextPage,
        hasMore: !!query.hasNextPage,
        error: query.error ? (query.error as Error).message : null,
        loadMore,
        refetchRows,
        jumpTo,
        jumpToStart,
        anchorLabel: anchor?.label ?? null,
        windowStartRow,
        windowCapped: rows.length >= WINDOW_ROWS,
        updateLocalCell,
        prependRow,
        removeLocalRowAt,
        applyChangeEvent,
    };
}
