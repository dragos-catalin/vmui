"use client";

import { Badge, Button, Checkbox, DataTable, EmptyState, Input, ToggleGroup, sortableHeader, type ToggleOption } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { AnyColumnDef } from "@/components/ui/data-table";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InstanceRow } from "@/lib/db/schema";
import type { PricedRow } from "@/lib/pricing";
import { formatUsdPerHour } from "@/lib/utils";
import { bulkInstanceAction } from "@/server/actions/instances";
import { Bookmark, BookmarkPlus, Camera, Download, Pin, Play, RotateCw, Search, Square, Trash2, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition, ViewTransition } from "react";
import { toast } from "sonner";
import { CostPill } from "./cost-pill";
import { InstanceActions } from "./instance-actions";
import { InstanceCard } from "./instance-card";
import { instanceMorphName } from "./instance-hero";
import { instanceLabel } from "./instance-label";
import { StatusBadge } from "./status-badge";
import { useIsNarrow } from "./use-breakpoint";

type StateFilter = "all" | "running" | "stopped" | "other";
type PlatformFilter = "all" | "linux" | "windows" | "macos";
type BulkAction = "start" | "stop" | "reboot" | "terminate" | "snapshot";

const FILTER_KEY = "vmui:instances:filters";
const SAVED_KEY = "vmui:instances:saved";
const LIVE_STATES = new Set(["running", "stopped"]);

interface SavedSearch {
  name: string;
  query: string;
  state: StateFilter;
  platform: PlatformFilter;
  provider: string;
}

function matchesState(filter: StateFilter, state: string): boolean {
  if (filter === "all") return true;
  if (filter === "other") return !LIVE_STATES.has(state);
  return state === filter;
}

export function InstancesExplorer({
  instances,
  providers,
  priceMap,
}: {
  instances: InstanceRow[];
  providers: string[];
  priceMap?: Record<string, PricedRow>;
}) {
  const t = useTranslations("vm.explorer");
  const tb = useTranslations("vm.bulk");
  const tState = useTranslations("vm.state");
  const tPlatform = useTranslations("vm.platform");
  const tc = useTranslations("common");
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const narrow = useIsNarrow();

  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);

  useEffect(() => {
    try {
      const f = localStorage.getItem(FILTER_KEY);
      if (f) {
        const parsed = JSON.parse(f) as Partial<SavedSearch>;
        if (parsed.state) setStateFilter(parsed.state);
        if (parsed.platform) setPlatformFilter(parsed.platform);
        if (parsed.provider) setProviderFilter(parsed.provider);
      }
      const saved = localStorage.getItem(SAVED_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as SavedSearch[];
        if (Array.isArray(parsed)) setSavedSearches(parsed.filter((s) => typeof s.state === "string"));
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ state: stateFilter, platform: platformFilter, provider: providerFilter }));
    } catch {
      /* storage unavailable */
    }
  }, [stateFilter, platformFilter, providerFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = instances.filter((i) => {
      if (!matchesState(stateFilter, i.state)) return false;
      if (platformFilter !== "all" && i.platform !== platformFilter) return false;
      if (providerFilter !== "all" && i.provider !== providerFilter) return false;
      if (!q) return true;
      const hay = [instanceLabel(i), i.name, i.providerInstanceId, i.publicIp, i.privateIp, i.publicDns, i.region, i.provider, i.instanceType, i.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    return rows.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return (b.lastSyncedAt?.getTime() ?? 0) - (a.lastSyncedAt?.getTime() ?? 0);
    });
  }, [instances, query, stateFilter, platformFilter, providerFilter]);

  const filterCount = (stateFilter !== "all" ? 1 : 0) + (platformFilter !== "all" ? 1 : 0) + (providerFilter !== "all" ? 1 : 0) + (query ? 1 : 0);

  function clearFilters() {
    setQuery("");
    setStateFilter("all");
    setPlatformFilter("all");
    setProviderFilter("all");
  }

  function exportCsv() {
    if (filtered.length === 0) return;
    const header = ["name", "providerInstanceId", "provider", "region", "state", "platform", "instanceType", "publicIp", "privateIp", "createdAt", "lastSyncedAt", "usdPerHour", "usdPerMonth"];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(",")];
    for (const i of filtered) {
      const price = priceMap?.[i.id]?.usdPerHour ?? null;
      lines.push(
        [
          instanceLabel(i),
          i.providerInstanceId,
          i.provider,
          i.region,
          i.state,
          i.platform,
          i.instanceType ?? "",
          i.publicIp ?? "",
          i.privateIp ?? "",
          i.createdAt?.toISOString() ?? "",
          i.lastSyncedAt?.toISOString() ?? "",
          price ?? "",
          price != null ? (price * 730).toFixed(2) : "",
        ]
          .map(escape)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vmui-instances-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(t("exported", { count: filtered.length }));
  }

  function persistSaved(next: SavedSearch[]) {
    setSavedSearches(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  }

  function saveCurrentSearch() {
    const name = window.prompt(t("saveNamePrompt"))?.trim();
    if (!name) return;
    const entry: SavedSearch = { name, query, state: stateFilter, platform: platformFilter, provider: providerFilter };
    persistSaved([...savedSearches.filter((s) => s.name !== name), entry]);
    toast.success(t("savedToast", { name }));
  }

  function applySaved(s: SavedSearch) {
    setQuery(s.query);
    setStateFilter(s.state);
    setPlatformFilter(s.platform);
    setProviderFilter(s.provider);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const selectAll = () => setSelected(new Set(filtered.map((i) => i.id)));
  const clearSelection = () => setSelected(new Set());
  const allVisibleSelected = filtered.length > 0 && filtered.every((i) => selected.has(i.id));

  async function bulk(action: BulkAction) {
    const ids = [...selected];
    if (ids.length === 0) return;
    const verb = tb(action);
    const ok = await confirm({
      title: tb("confirmTitle", { verb, count: ids.length }),
      description:
        action === "terminate"
          ? tb("confirmTerminate", { count: ids.length })
          : action === "snapshot"
            ? tb("confirmSnapshot", { count: ids.length })
            : tb("confirmGeneric", { action: verb.toLowerCase(), count: ids.length }),
      tone: action === "terminate" ? "danger" : action === "stop" ? "warning" : "info",
      confirmText: verb,
    });
    if (!ok) return;
    start(async () => {
      const r = await bulkInstanceAction({ ids, action });
      if (r.failed === 0) toast.success(tb("requested", { verb, count: r.succeeded }));
      else toast.error(tb("partial", { ok: r.succeeded, failed: r.failed }));
      clearSelection();
      router.refresh();
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
        e.preventDefault();
        document.getElementById("vmui-search")?.focus();
      } else if (e.key === "Escape" && selected.size > 0) {
        clearSelection();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  const selectionActive = selected.size > 0;

  const stateOptions: readonly ToggleOption<StateFilter>[] = [
    { value: "all", label: t("allStates") },
    { value: "running", label: tState("running") },
    { value: "stopped", label: tState("stopped") },
    { value: "other", label: tState("pending") },
  ];
  const platformOptions: readonly ToggleOption<PlatformFilter>[] = [
    { value: "all", label: t("allPlatforms") },
    { value: "linux", label: tPlatform("linux") },
    { value: "windows", label: tPlatform("windows") },
    { value: "macos", label: tPlatform("macos") },
  ];

  const columns = useMemo<AnyColumnDef<InstanceRow>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: () => (
          <Checkbox
            aria-label={t("selectAllVisible")}
            checked={allVisibleSelected}
            indeterminate={selectionActive && !allVisibleSelected}
            onCheckedChange={(v) => (v ? selectAll() : clearSelection())}
          />
        ),
        cell: ({ row }) => (
          <Checkbox aria-label={t("selectRow", { name: instanceLabel(row.original) })} checked={selected.has(row.original.id)} onCheckedChange={() => toggleSelect(row.original.id)} />
        ),
      },
      {
        id: "name",
        accessorFn: (r) => instanceLabel(r),
        header: sortableHeader(t("columns.name")),
        cell: ({ row }) => {
          const i = row.original;
          return (
            <div className="flex min-w-0 max-w-[16rem] items-center gap-1.5 sm:max-w-[22rem]">
              {i.pinned && <Pin className="size-3 shrink-0 text-primary" aria-label={t("pinned")} />}
              <ViewTransition name={instanceMorphName(i.id)}>
                <Link
                  href={`/instances/${encodeURIComponent(i.id)}`}
                  className="truncate font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  title={instanceLabel(i)}
                >
                  {instanceLabel(i)}
                </Link>
              </ViewTransition>
            </div>
          );
        },
      },
      {
        id: "provider",
        accessorKey: "provider",
        header: sortableHeader(t("columns.provider")),
        cell: ({ getValue }) => <Badge variant="muted">{getValue<string>()}</Badge>,
      },
      {
        id: "region",
        accessorKey: "region",
        header: sortableHeader(t("columns.region")),
        cell: ({ getValue }) => <span className="whitespace-nowrap text-muted" title={getValue<string>()}>{getValue<string>()}</span>,
      },
      {
        id: "state",
        accessorKey: "state",
        header: sortableHeader(t("columns.state")),
        cell: ({ getValue }) => <StatusBadge state={getValue<string>()} />,
      },
      {
        id: "size",
        accessorFn: (r) => r.instanceType ?? "",
        header: sortableHeader(t("columns.size")),
        cell: ({ row }) => <span className="whitespace-nowrap font-mono text-xs text-muted">{row.original.instanceType ?? "—"}</span>,
      },
      {
        id: "price",
        accessorFn: (r) => priceMap?.[r.id]?.usdPerHour ?? -1,
        header: sortableHeader(t("columns.price")),
        cell: ({ row }) => {
          const p = priceMap?.[row.original.id];
          return p ? <span className="whitespace-nowrap font-mono text-xs tabular-nums">{p.usdPerHour == null ? "—" : formatUsdPerHour(p.usdPerHour)}</span> : <span className="text-muted">—</span>;
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t/priceMap are stable per render; selection state drives re-render
    [selected, allVisibleSelected, selectionActive, priceMap, t],
  );

  return (
    <m.div
      className="min-w-0 space-y-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            id="vmui-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAria")}
            className="pl-8 pr-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t("clearSearch")}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup size="sm" value={stateFilter} onValueChange={setStateFilter} options={stateOptions} aria-label={t("stateFilter")} />
          <ToggleGroup size="sm" value={platformFilter} onValueChange={setPlatformFilter} options={platformOptions} aria-label={t("platformFilter")} className="hidden md:inline-flex" />
          {providers.length > 1 && (
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("providerFilter")}>
                <SelectValue placeholder={t("provider")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allProviders")}</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="ghost" size="sm" onClick={exportCsv} disabled={filtered.length === 0} title={t("exportCsvHint")}>
            <Download className="size-3.5" aria-hidden /> {t("exportCsv")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={t("savedSearches")}>
                <Bookmark className="size-3.5" aria-hidden />
                {savedSearches.length > 0 && <span className="text-2xs text-muted">{savedSearches.length}</span>}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel>{t("savedSearches")}</DropdownMenuLabel>
              {savedSearches.length === 0 && <div className="px-2 py-2 text-xs text-muted">{t("noSavedSearches")}</div>}
              {savedSearches.map((s) => (
                <div key={s.name} className="flex items-center gap-1 px-2 py-1 text-xs hover:bg-bg-muted">
                  <button type="button" onClick={() => applySaved(s)} className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" title={t("applySaved", { name: s.name })}>
                    {s.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => persistSaved(savedSearches.filter((x) => x.name !== s.name))}
                    className="grid size-7 place-items-center rounded-full text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={t("deleteSaved", { name: s.name })}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </div>
              ))}
              <DropdownMenuSeparator />
              <button
                type="button"
                onClick={saveCurrentSearch}
                disabled={filterCount === 0}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <BookmarkPlus className="size-3.5" aria-hidden /> {t("saveCurrent")}
              </button>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {filterCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{t("showing", { shown: filtered.length, total: instances.length })}</span>
          <Button variant="link" size="sm" onClick={clearFilters} className="h-auto text-xs">
            {t("clearFilters")}
          </Button>
        </div>
      )}

      <AnimatePresence>
        {selectionActive && (
          <m.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            role="toolbar"
            aria-label={tb("selected", { count: selected.size })}
            className="sticky top-2 z-[var(--z-sticky)] flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface/90 p-2 shadow-lg backdrop-blur-md"
          >
            <Badge variant="info">{tb("selected", { count: selected.size })}</Badge>
            <Button size="sm" variant="ghost" onClick={selectAll}>
              {tb("selectAll", { count: filtered.length })}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              {tb("clear")}
            </Button>
            <div className="ml-auto flex flex-wrap gap-1">
              <Button size="sm" variant="secondary" onClick={() => bulk("start")} loading={pending}>
                <Play className="size-3.5" aria-hidden /> {tb("start")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => bulk("stop")} disabled={pending}>
                <Square className="size-3.5" aria-hidden /> {tb("stop")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => bulk("reboot")} disabled={pending}>
                <RotateCw className="size-3.5" aria-hidden /> {tb("reboot")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => bulk("snapshot")} disabled={pending}>
                <Camera className="size-3.5" aria-hidden /> {tb("snapshot")}
              </Button>
              <Button size="sm" variant="danger" onClick={() => bulk("terminate")} disabled={pending}>
                <Trash2 className="size-3.5" aria-hidden /> {tb("terminate")}
              </Button>
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {filtered.length === 0 ? (
        <EmptyState
          illustration="search"
          icon={<Search />}
          title={t("noMatchTitle")}
          description={t("noMatchDescription")}
          action={
            filterCount > 0 ? (
              <Button size="sm" variant="secondary" onClick={clearFilters}>
                {t("clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {narrow !== true && (
            <DataTable
              columns={columns}
              data={filtered}
              getRowId={(r) => r.id}
              pageSize={50}
              rowActions={(row) => (
                <div className="flex items-center gap-1">
                  {priceMap?.[row.id] && <CostPill usdPerHour={priceMap[row.id]?.usdPerHour ?? null} source={priceMap[row.id]?.source ?? null} showMonthly={false} className="hidden xl:inline-flex" />}
                  <InstanceActions instance={row} />
                </div>
              )}
              emptyState={<EmptyState illustration="search" compact title={tc("noResults")} />}
            />
          )}
          {narrow === true && (
            <div className="grid min-w-0 grid-cols-1 gap-3">
              <AnimatePresence initial={false} mode="popLayout">
                {filtered.map((i, idx) => (
                  <InstanceCard key={i.id} instance={i} index={idx} selected={selected.has(i.id)} onToggleSelect={toggleSelect} selectionActive={selectionActive} price={priceMap?.[i.id]} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </>
      )}

      {instances.some((i) => i.pinned) && (
        <p className="flex items-center gap-1.5 text-2xs text-muted">
          <Pin className="size-3" aria-hidden /> {t("pinnedHint")}
        </p>
      )}
    </m.div>
  );
}
