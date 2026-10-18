"use client";

import { Badge, Button, EmptyState, PageHeader, PageSection, PageShell, Skeleton, ToggleGroup } from "@/components/ui";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { TopologyData, TopologyEdge, TopologyNode } from "@/server/queries/topology";
import { Box, Maximize2, Network, RotateCcw, Save, Square } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { rgbToCss, useResolvedTokens } from "./theme-colors";
import { buildPalette, EDGE_KINDS, initialLayout, KIND_SIZE, LAYOUT_STORAGE_KEY, NODE_KINDS, TOKENS, type Palette } from "./topology-shared";

const TopologyScene3D = dynamic(() => import("./topology-scene-3d"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
});

interface Props {
  data: TopologyData;
}

const SETTINGS_STORAGE_KEY = "vmui:topology:settings";

interface SavedSettings {
  view: "3d" | "2d";
  edgeKinds: TopologyEdge["kind"][];
  providers: string[];
}

const DEFAULT_SETTINGS: SavedSettings = {
  view: "3d",
  edgeKinds: ["owned-by", "attaches", "in-group", "in-vpc", "in-subnet"],
  providers: [],
};

function Canvas2D({ data, palette, onSelect }: { data: TopologyData; palette: Palette; onSelect: (n: TopologyNode) => void }) {
  const positions = useMemo(() => initialLayout(data.nodes), [data]);
  const points = data.nodes.map((n) => {
    const p = positions.get(n.id)!;
    return { node: n, x: p.x * 30, y: p.z * 30 };
  });
  const pointById = new Map(points.map((p) => [p.node.id, p]));
  const box = points.reduce(
    (b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const pad = 60;
  const viewBox = Number.isFinite(box.minX)
    ? `${box.minX - pad} ${box.minY - pad} ${Math.max(200, box.maxX - box.minX + pad * 2)} ${Math.max(150, box.maxY - box.minY + pad * 2)}`
    : "0 0 800 600";
  return (
    <svg viewBox={viewBox} className="h-full w-full" style={{ background: rgbToCss(palette.background) }}>
      {data.edges.map((e, i) => {
        const a = pointById.get(e.from);
        const b = pointById.get(e.to);
        if (!a || !b) return null;
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={rgbToCss(palette.edge[e.kind] ?? palette.fallback)} strokeOpacity={0.45} strokeWidth={1} />;
      })}
      {points.map((p) => (
        <g key={p.node.id} onClick={() => onSelect(p.node)} style={{ cursor: "pointer" }}>
          <circle cx={p.x} cy={p.y} r={(KIND_SIZE[p.node.kind] ?? 0.3) * 12} fill={rgbToCss(palette.node[p.node.kind] ?? palette.fallback)} />
          <text x={p.x + 8} y={p.y + 3} fontSize="9" fill={rgbToCss(palette.label)}>
            {p.node.label.slice(0, 18)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function NodeDetails({ node, palette, onClose }: { node: TopologyNode | null; palette: Palette; onClose: () => void }) {
  const t = useTranslations("ops.topology");
  return (
    <Sheet open={node !== null} onOpenChange={(o) => !o && onClose()}>
      {node && (
        <SheetContent title={node.label} description={`${t(`kinds.${node.kind}`)} · ${node.provider} · ${node.region || "—"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-block size-2.5 rounded-full" style={{ background: rgbToCss(palette.node[node.kind] ?? palette.fallback) }} aria-hidden />
            <Badge variant="muted">{t(`kinds.${node.kind}`)}</Badge>
            {node.status && <Badge variant={node.status === "running" ? "success" : "muted"}>{node.status}</Badge>}
          </div>
          {node.meta && Object.values(node.meta).some((v) => v != null && v !== "") && (
            <dl className="space-y-1 text-xs">
              {Object.entries(node.meta).map(([k, v]) =>
                v == null || v === "" ? null : (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-muted">{k}</dt>
                    <dd className="min-w-0 truncate font-mono" title={String(v)}>{String(v)}</dd>
                  </div>
                ),
              )}
            </dl>
          )}
          {node.kind === "instance" && (
            <Button variant="secondary" asChild>
              <Link href={`/instances/${encodeURIComponent(node.id)}`}>{t("openInstance")}</Link>
            </Button>
          )}
          {node.kind === "account" && (
            <Button variant="secondary" asChild>
              <Link href={`/accounts/${encodeURIComponent(node.accountId)}`}>{t("openAccount")}</Link>
            </Button>
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}

function readSettings(): SavedSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SavedSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function TopologyGraph({ data }: Props) {
  const t = useTranslations("ops.topology");
  const tc = useTranslations("common");
  const tokens = useResolvedTokens(TOKENS);
  const palette = useMemo(() => (tokens ? buildPalette(tokens) : null), [tokens]);
  const [hover, setHover] = useState<TopologyNode | null>(null);
  const [selected, setSelected] = useState<TopologyNode | null>(null);
  const [settings, setSettings] = useState<SavedSettings>(readSettings);
  const [saveSignal, setSaveSignal] = useState(0);
  const [fitSignal, setFitSignal] = useState(0);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const accounts = useMemo(() => data.nodes.filter((n) => n.kind === "account"), [data]);
  const providers = useMemo(() => Array.from(new Set(data.nodes.map((n) => n.provider))).filter(Boolean), [data]);

  const filtered = useMemo<TopologyData>(() => {
    const nodes = data.nodes.filter((n) => {
      if (accountFilter && n.accountId !== accountFilter && n.id !== `acc:${accountFilter}`) return false;
      if (settings.providers.length > 0 && !settings.providers.includes(n.provider)) return false;
      return true;
    });
    const allowedIds = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => allowedIds.has(e.from) && allowedIds.has(e.to) && settings.edgeKinds.includes(e.kind));
    return { nodes, edges, generatedAt: data.generatedAt };
  }, [data, accountFilter, settings]);

  const presentKinds = useMemo(() => NODE_KINDS.filter((k) => filtered.nodes.some((n) => n.kind === k)), [filtered]);

  const toggleEdge = (k: TopologyEdge["kind"]) =>
    setSettings((s) => ({ ...s, edgeKinds: s.edgeKinds.includes(k) ? s.edgeKinds.filter((x) => x !== k) : [...s.edgeKinds, k] }));
  const toggleProvider = (p: string) =>
    setSettings((s) => ({ ...s, providers: s.providers.includes(p) ? s.providers.filter((x) => x !== p) : [...s.providers, p] }));

  const header = (
    <PageHeader
      title={t("title")}
      description={t("description")}
      icon={<Network />}
      badge={<Badge variant="muted">{t("counts", { nodes: filtered.nodes.length, edges: filtered.edges.length })}</Badge>}
      actions={
        data.nodes.length > 0 ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setFitSignal((s) => s + 1)}>
              <Maximize2 className="size-4" aria-hidden />
              {t("fit")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSaveSignal((s) => s + 1)} disabled={settings.view !== "3d"}>
              <Save className="size-4" aria-hidden />
              {t("saveLayout")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
                window.location.reload();
              }}
            >
              <RotateCcw className="size-4" aria-hidden />
              {t("resetLayout")}
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (data.nodes.length === 0) {
    return (
      <PageShell>
        {header}
        <EmptyState
          icon={<Network />}
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            <Button asChild>
              <Link href="/accounts">{t("empty.cta")}</Link>
            </Button>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      {header}

      <PageSection
        title={t("filters.title")}
        description={t("filters.description")}
        action={
          <ToggleGroup
            size="sm"
            value={settings.view}
            onValueChange={(v) => setSettings((s) => ({ ...s, view: v }))}
            aria-label={t("filters.view")}
            options={[
              { value: "3d", label: t("filters.view3d"), icon: <Box className="size-3.5" aria-hidden /> },
              { value: "2d", label: t("filters.view2d"), icon: <Square className="size-3.5" aria-hidden /> },
            ]}
          />
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.length > 0 && (
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-xs text-muted">{t("filters.accounts")}</legend>
              <div className="flex flex-wrap gap-1.5">
                <Chip pressed={accountFilter === null} onClick={() => setAccountFilter(null)}>
                  {tc("all")}
                </Chip>
                {accounts.map((a) => (
                  <Chip key={a.id} pressed={accountFilter === a.accountId} onClick={() => setAccountFilter(a.accountId)}>
                    {a.label}
                  </Chip>
                ))}
              </div>
            </fieldset>
          )}
          {providers.length > 0 && (
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-xs text-muted">{t("filters.providers")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {providers.map((p) => (
                  <Chip key={p} pressed={settings.providers.length === 0 || settings.providers.includes(p)} onClick={() => toggleProvider(p)}>
                    {p}
                  </Chip>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs text-muted">{t("filters.edges")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {EDGE_KINDS.map((k) => (
                <Chip key={k} pressed={settings.edgeKinds.includes(k)} onClick={() => toggleEdge(k)}>
                  <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: palette ? rgbToCss(palette.edge[k]) : undefined }} aria-hidden />
                  {t(`edges.${k}`)}
                </Chip>
              ))}
            </div>
          </fieldset>
        </div>
      </PageSection>

      <PageSection title={t("graph.title")} description={t("graph.hint")} className="hidden md:block">
        <div
          role="img"
          aria-label={t("graph.aria", { nodes: filtered.nodes.length, edges: filtered.edges.length })}
          className="relative aspect-[16/10] min-h-[420px] max-h-[72vh] w-full overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg"
        >
          {!palette ? (
            <Skeleton className="h-full w-full rounded-none" />
          ) : settings.view === "3d" ? (
            <TopologyScene3D
              data={filtered}
              palette={palette}
              hover={hover}
              selected={selected}
              onHover={setHover}
              onSelect={setSelected}
              saveSignal={saveSignal}
              fitSignal={fitSignal}
            />
          ) : (
            <Canvas2D key={fitSignal} data={filtered} palette={palette} onSelect={setSelected} />
          )}
        </div>
        <div role="list" className="mt-3 flex flex-wrap gap-1.5" aria-label={t("legend.title")}>
          {presentKinds.map((k) => (
            <Badge key={k} variant="default" role="listitem">
              <span className="inline-block size-2 rounded-full" style={{ background: palette ? rgbToCss(palette.node[k]) : undefined }} aria-hidden />
              {t(`kinds.${k}`)}
            </Badge>
          ))}
        </div>
      </PageSection>

      <PageSection title={t("list.title")} description={t("list.description")} className="md:hidden">
        {filtered.nodes.length === 0 ? (
          <EmptyState compact illustration="search" icon={<Network />} title={t("list.emptyTitle")} description={t("list.emptyDescription")} />
        ) : (
        <ul className="divide-y divide-border">
          {filtered.nodes.slice(0, 200).map((n, i) => (
            <m.li
              key={n.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.035 }}
            >
              <button
                type="button"
                onClick={() => setSelected(n)}
                className="flex min-h-11 w-full items-center gap-3 px-1 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: palette ? rgbToCss(palette.node[n.kind]) : undefined }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={n.label}>{n.label}</span>
                  <span className="block truncate text-xs text-muted">
                    {n.provider} · {n.region || "—"}
                  </span>
                </span>
                <Badge variant="muted">{t(`kinds.${n.kind}`)}</Badge>
              </button>
            </m.li>
          ))}
        </ul>
        )}
        {filtered.nodes.length > 200 && <p className="mt-2 text-xs text-muted">{t("list.truncated", { count: filtered.nodes.length - 200 })}</p>}
      </PageSection>

      {palette && <NodeDetails node={selected} palette={palette} onClose={() => setSelected(null)} />}
    </PageShell>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        pressed ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_14%,transparent)] text-fg" : "border-border text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
