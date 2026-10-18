"use client";

import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Check, Copy, Search, WrapText } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

export interface LogViewerProps {
  /** Log content; either pre-split lines or one string (split on `\n`). */
  lines?: readonly string[];
  text?: string;
  title?: React.ReactNode;
  /** Height utility class for the scroll area; default `max-h-80`. */
  height?: string;
  className?: string;
  /** Start with auto-scroll on (default true). The toggle is always shown. */
  autoScroll?: boolean;
  /** Show the search box (default true). */
  searchable?: boolean;
  /** Wrap long lines (default false → horizontal scroll). */
  wrap?: boolean;
  loading?: boolean;
  emptyLabel?: React.ReactNode;
  /** Extra toolbar controls rendered next to the built-in ones. */
  actions?: React.ReactNode;
  /** Optional per-line tone, e.g. colour stderr lines. */
  lineTone?: (line: string, index: number) => "default" | "muted" | "success" | "warning" | "danger" | undefined;
}

const TONE: Record<NonNullable<ReturnType<NonNullable<LogViewerProps["lineTone"]>>>, string> = {
  default: "",
  muted: "text-fg-muted",
  success: "text-[color-mix(in_oklch,var(--color-success)_75%,var(--color-fg))]",
  warning: "text-warning-text",
  danger: "text-[color-mix(in_oklch,var(--color-danger)_80%,var(--color-fg))]",
};

/** Line height of `text-xs leading-relaxed` (12px * 1.625). */
const LINE_PX = 19.5;

function highlight(line: string, q: string): React.ReactNode {
  if (!q) return line;
  const lower = line.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let idx = lower.indexOf(needle, from);
  let k = 0;
  while (idx !== -1) {
    if (idx > from) parts.push(line.slice(from, idx));
    parts.push(
      <mark key={k++} className="rounded-[2px] bg-[color-mix(in_oklch,var(--color-warning)_45%,transparent)] text-fg">
        {line.slice(idx, idx + needle.length)}
      </mark>,
    );
    from = idx + needle.length;
    idx = lower.indexOf(needle, from);
  }
  if (from < line.length) parts.push(line.slice(from));
  return parts;
}

/**
 * Streaming log panel. Rows are virtualised (TanStack Virtual), so a 50k-line build log costs the same
 * as a 50-line one. The log region is `aria-live="off"`: an unbounded stream would flood a screen reader;
 * only search results are announced, through a separate status region.
 */
export function LogViewer({
  lines,
  text,
  title,
  height = "max-h-80",
  className,
  autoScroll: autoScrollDefault = true,
  searchable = true,
  wrap: wrapDefault = false,
  loading = false,
  emptyLabel,
  actions,
  lineTone,
}: LogViewerProps) {
  const t = useTranslations("ops.logViewer");
  const all = React.useMemo(() => lines ?? (text ? text.split("\n") : []), [lines, text]);
  const [query, setQuery] = React.useState("");
  const [autoScroll, setAutoScroll] = React.useState(autoScrollDefault);
  const [wrap, setWrap] = React.useState(wrapDefault);
  const [copied, setCopied] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const visible = React.useMemo(() => {
    if (!query) return all.map((line, i) => ({ line, i }));
    const q = query.toLowerCase();
    return all.map((line, i) => ({ line, i })).filter(({ line }) => line.toLowerCase().includes(q));
  }, [all, query]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_PX,
    overscan: 24,
  });

  React.useEffect(() => {
    // Remeasure when wrapping toggles: row heights change.
    virtualizer.measure();
  }, [wrap, virtualizer]);

  React.useEffect(() => {
    if (!autoScroll || visible.length === 0) return;
    virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
  }, [visible.length, autoScroll, virtualizer]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(all.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const matchCount = query ? visible.length : 0;
  const items = virtualizer.getVirtualItems();

  return (
    <div className={cn("surface flex min-w-0 flex-col overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {title && (
          <span className="min-w-0 truncate text-xs font-semibold" title={typeof title === "string" ? title : undefined}>
            {title}
          </span>
        )}
        <span className="text-xs tabular-nums text-fg-muted">{t("lines", { count: all.length })}</span>
        <span role="status" className={cn("text-xs tabular-nums text-fg-muted", !query && "sr-only")}>
          {query ? t("matches", { count: matchCount }) : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {searchable && (
            <div className="relative">
              <Search className="pointer-events-none absolute inset-y-0 left-2 my-auto size-3.5 text-fg-muted" aria-hidden />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("search")}
                aria-label={t("search")}
                className="h-8 w-40 pl-7 text-xs"
              />
            </div>
          )}
          <Button
            type="button"
            variant={wrap ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            aria-pressed={wrap}
            aria-label={t("wrap")}
            title={t("wrap")}
            onClick={() => setWrap((w) => !w)}
          >
            <WrapText className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant={autoScroll ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            aria-pressed={autoScroll}
            aria-label={t("autoScroll")}
            title={t("autoScroll")}
            onClick={() => setAutoScroll((a) => !a)}
          >
            <ArrowDownToLine className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={copied ? t("copied") : t("copy")}
            title={copied ? t("copied") : t("copy")}
            onClick={copy}
            disabled={all.length === 0}
          >
            {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          </Button>
          {actions}
        </div>
      </div>
      <div
        ref={scrollRef}
        role="log"
        aria-live="off"
        aria-busy={loading || undefined}
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={0}
        className={cn(
          "overflow-auto bg-bg-muted/40 p-3 font-mono text-xs leading-relaxed [scrollbar-width:thin] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          height,
        )}
      >
        {all.length === 0 ? (
          <p className="text-fg-muted">{loading ? t("waiting") : (emptyLabel ?? t("empty"))}</p>
        ) : (
          <ol
            className={cn("relative min-w-0", wrap ? "whitespace-pre-wrap break-all" : "w-max min-w-full whitespace-pre")}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((vi) => {
              const row = visible[vi.index];
              if (!row) return null;
              return (
                <li
                  key={row.i}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={cn("absolute left-0 top-0 w-full tabular-nums", TONE[lineTone?.(row.line, row.i) ?? "default"])}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  {highlight(row.line, query) || "\u00a0"}
                </li>
              );
            })}
          </ol>
        )}
        {loading && all.length > 0 && <span className="pulse-dot mt-1 inline-block size-1.5 rounded-full bg-primary" aria-hidden />}
      </div>
    </div>
  );
}
