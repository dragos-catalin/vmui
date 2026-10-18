"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";

export type InstanceTabId = "overview" | "monitoring" | "operations" | "notes";

/** Groups the detail page's sections; `#snapshots`-style deep links land on the owning tab. */
export function InstanceTabs({ panels }: { panels: Partial<Record<InstanceTabId, React.ReactNode>> }) {
  const t = useTranslations("vm.detail.tabs");
  const ids = (Object.keys(panels) as InstanceTabId[]).filter((k) => panels[k] != null);
  const [value, setValue] = React.useState<InstanceTabId>(ids[0] ?? "overview");
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState({ start: false, end: false });

  // Fade only the edge(s) that actually hide tabs, so overflow has an affordance.
  const measure = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft > 2, end: max - el.scrollLeft > 2 });
  }, []);
  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  React.useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    const owner = ids.find((k) => k === hash) ?? (hash === "snapshots" || hash === "schedules" ? "operations" : undefined);
    if (owner && panels[owner] != null) setValue(owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  if (ids.length <= 1) return <>{ids[0] ? panels[ids[0]] : null}</>;

  return (
    <Tabs value={value} onValueChange={(v) => setValue(v as InstanceTabId)}>
      <TabsList
        ref={listRef}
        onScroll={measure}
        className={cn(
          "-mx-4 h-auto w-[calc(100%+2rem)] max-w-[calc(100%+2rem)] justify-start overflow-x-auto rounded-none bg-transparent px-4 [scrollbar-width:none] sm:mx-0 sm:w-auto sm:max-w-full sm:rounded-[var(--radius-md)] sm:bg-bg-muted sm:px-1 [&::-webkit-scrollbar]:hidden",
          edges.start && edges.end && "[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-2rem),transparent)]",
          edges.start && !edges.end && "[mask-image:linear-gradient(to_right,transparent,black_2rem)]",
          !edges.start && edges.end && "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
        )}
      >
        {ids.map((id) => (
          <TabsTrigger
            key={id}
            value={id}
            className="relative h-9 min-w-[2.5rem] data-[state=active]:bg-transparent data-[state=active]:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {value === id && (
              <m.span
                layoutId="inst-tab"
                className="absolute inset-0 rounded-[var(--radius-sm)] bg-surface shadow-sm"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                aria-hidden
              />
            )}
            <span className="relative">{t(id)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {ids.map((id) => (
        <TabsContent key={id} value={id} className="space-y-6">
          {panels[id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
