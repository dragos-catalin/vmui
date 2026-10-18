"use client";

import { cn } from "@/lib/utils";
import {
    columnFilteringFeature,
    createFilteredRowModel,
    createPaginatedRowModel,
    createSortedRowModel,
    filterFns,
    FlexRender,
    globalFilteringFeature,
    rowPaginationFeature,
    rowSortingFeature,
    sortFns,
    tableFeatures,
    useTable,
    type Column,
    type RowData,
    type SortingState,
    type ColumnDef as TanColumnDef,
    type Row as TanRow,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, RotateCw, Search, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "./button";
import { EmptyState } from "./empty-state";
import { Input } from "./input";
import { SkeletonTable } from "./skeleton";

// One feature bag for every table in the app: sorting, global search, pagination.
// Consumers type their columns as `ColumnDef<Row>` and never see TFeatures.
const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns,
  filterFns,
});
type Features = typeof features;

export type ColumnDef<TData extends RowData, TValue = unknown> = TanColumnDef<Features, TData, TValue>;
export type Row<TData extends RowData> = TanRow<Features, TData>;

export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
  className,
}: {
  column: Column<Features, TData, TValue>;
  title: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("common");
  if (!column.getCanSort()) return <span className={className}>{title}</span>;
  const sorted = column.getIsSorted();
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  // The visible title stays the accessible name; the th carries aria-sort, the hint says what a click does.
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        "-ml-2 inline-flex min-h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-left font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        sorted && "text-fg",
        className,
      )}
    >
      {title}
      <span className="sr-only">, {sorted === "asc" ? t("sortDescending") : t("sortAscending")}</span>
      <Icon className={cn("size-3.5", !sorted && "opacity-60")} aria-hidden />
    </button>
  );
}

export function sortableHeader<TData extends RowData, TValue>(label: React.ReactNode): ColumnDef<TData, TValue>["header"] {
  return ({ column }) => <DataTableColumnHeader column={column} title={label} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- column value types vary per column; TanStack's own examples use `any` here
export type AnyColumnDef<TData extends RowData> = ColumnDef<TData, any>;

export interface DataTableProps<TData extends RowData> {
  columns: AnyColumnDef<TData>[];
  data: TData[];
  loading?: boolean;
  /** Load failure: renders an error panel instead of rows; `onRetry` adds a retry button. */
  error?: React.ReactNode;
  onRetry?: () => void;
  emptyState?: React.ReactNode;
  getRowId?: (row: TData, index: number) => string;
  onRowClick?: (row: TData) => void;
  enableSorting?: boolean;
  pageSize?: number;
  toolbar?: React.ReactNode;
  searchable?: boolean;
  /** Header sticks inside the table's own scroll box (capped at `maxHeight`), never to the page. */
  stickyHeader?: boolean;
  /** CSS max-height of the scroll box when `stickyHeader` is on, e.g. "70dvh". Default 70dvh. */
  maxHeight?: string;
  dense?: boolean;
  rowActions?: (row: TData) => React.ReactNode;
  className?: string;
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  loading = false,
  error,
  onRetry,
  emptyState,
  getRowId,
  onRowClick,
  enableSorting = true,
  pageSize = 25,
  toolbar,
  searchable = false,
  stickyHeader = true,
  maxHeight = "70dvh",
  dense = false,
  rowActions,
  className,
}: DataTableProps<TData>) {
  const t = useTranslations("common");
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");

  const table = useTable({
    features,
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getRowId,
    enableSorting,
    globalFilterFn: "includesString",
    initialState: { pagination: { pageIndex: 0, pageSize } },
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const paginated = filteredCount > pageSize;
  const pageIndex = table.state.pagination?.pageIndex ?? 0;
  const from = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min(filteredCount, (pageIndex + 1) * pageSize);
  const cellPad = dense ? "px-3 py-1.5" : "px-3 py-2.5";
  const colCount = columns.length + (rowActions ? 1 : 0);

  return (
    <div className={cn("space-y-3", className)}>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" aria-hidden />
              <Input
                type="search"
                value={globalFilter}
                onChange={(e) => {
                  setGlobalFilter(e.target.value);
                  table.setPageIndex(0);
                }}
                placeholder={t("search")}
                aria-label={t("search")}
                className="pl-8"
              />
            </div>
          )}
          {toolbar && <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}

      {error ? (
        <EmptyState
          compact
          tone="error"
          icon={<TriangleAlert />}
          title={t("loadFailed")}
          description={typeof error === "string" ? error : undefined}
          action={
            onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCw className="size-3.5" aria-hidden />
                {t("retry")}
              </Button>
            ) : undefined
          }
        />
      ) : loading ? (
        <SkeletonTable rows={Math.min(pageSize, 8)} cols={Math.min(colCount, 6)} />
      ) : (
        <div
          role="region"
          aria-label={t("scrollRegion")}
          tabIndex={0}
          className={cn(
            "min-w-0 max-w-full rounded-[var(--radius-lg)] border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            stickyHeader ? "overflow-auto" : "overflow-x-auto",
          )}
          style={stickyHeader ? { maxHeight } : undefined}
        >
          <table className="w-full text-sm">
            <thead className={cn("text-xs text-fg-muted", stickyHeader && "sticky top-0 z-[1] bg-surface")}>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border">
                  {hg.headers.map((h) => {
                    const sorted = h.column.getIsSorted();
                    return (
                      <th
                        key={h.id}
                        scope="col"
                        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : h.column.getCanSort() ? "none" : undefined}
                        className={cn("whitespace-nowrap text-left font-medium", cellPad)}
                      >
                        {h.isPlaceholder ? null : <FlexRender header={h} />}
                      </th>
                    );
                  })}
                  {rowActions && (
                    <th scope="col" className={cn("text-right font-medium", cellPad)}>
                      <span className="sr-only">{t("actions")}</span>
                    </th>
                  )}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="p-3">
                    {emptyState ?? <EmptyState compact bare title={t("noResults")} />}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(row.original);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "border-b border-border transition-colors last:border-b-0 hover:bg-bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {row.getAllCells().map((cell) => (
                      <td key={cell.id} className={cn("align-middle", cellPad)}>
                        <FlexRender cell={cell} />
                      </td>
                    ))}
                    {rowActions && (
                      <td className={cn("text-right align-middle", cellPad)} onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center justify-end gap-1">{rowActions(row.original)}</div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && paginated && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
          <span className="tabular-nums">{t("showing", { from, to, total: filteredCount })}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
              {t("previous")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
              {t("next")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
