import { getTranslations } from "next-intl/server";
import { Skeleton, SkeletonCard, SkeletonList, SkeletonStat, SkeletonTable } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface PageSkeletonProps {
  header?: boolean;
  stats?: number;
  table?: { rows: number; cols: number };
  cards?: number;
  list?: number;
  form?: number;
  narrow?: boolean;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function SkeletonHeader() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 rounded-[var(--radius-md)]" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3 w-80 max-w-[70vw]" />
      </div>
    </div>
  );
}

function SkeletonForm({ fields }: { fields: number }) {
  return (
    <div className="surface space-y-5 p-4 sm:p-5">
      {range(fields).map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <div className="flex justify-end gap-2 pt-2">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-28" />
      </div>
    </div>
  );
}

export async function PageSkeleton({ header, stats, table, cards, list, form, narrow }: PageSkeletonProps) {
  const t = await getTranslations("common");
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn("mx-auto w-full space-y-6", narrow ? "max-w-3xl" : "max-w-[var(--spacing-content)]")}
    >
      <span className="sr-only">{t("loading")}</span>
      {header ? <SkeletonHeader /> : null}
      {stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {range(stats).map((i) => (
            <SkeletonStat key={i} />
          ))}
        </div>
      ) : null}
      {table ? <SkeletonTable rows={table.rows} cols={table.cols} /> : null}
      {cards ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {range(cards).map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : null}
      {list ? <SkeletonList rows={list} className="surface p-4 sm:p-5" /> : null}
      {form ? <SkeletonForm fields={form} /> : null}
    </div>
  );
}
