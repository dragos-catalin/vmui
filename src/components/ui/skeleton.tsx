import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("skeleton", className)} {...props} />;
}

const LINE_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-2/3", "w-3/4", "w-5/6"] as const;

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", LINE_WIDTHS[i % LINE_WIDTHS.length] ?? "w-full")} />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("surface space-y-3 p-4 sm:p-5", className)}>
      <Skeleton className="h-4 w-1/3" />
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("surface flex flex-col gap-2 p-4 sm:p-5", className)}>
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-6 w-2/3" />
    </div>
  );
}

export function SkeletonTable({ rows = 6, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("overflow-hidden rounded-[var(--radius-lg)] border border-border", className)}>
      <div className="flex gap-4 border-b border-border bg-bg-muted/60 px-4 py-3">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-border px-4 py-3 last:border-b-0">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn("h-3 flex-1", c === 0 && "max-w-[40%]")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonList({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("space-y-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
