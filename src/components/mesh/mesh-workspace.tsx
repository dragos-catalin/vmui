"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { toError } from "@/components/settings/adapt";
import { Badge, Button, Checkbox, DataTable, EmptyState, Field, Input, PageHeader, PageSection, PageShell, Switch, type ColumnDef } from "@/components/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { autoBuildMeshFromFleetAction, generateTailscaleCommandAction, generateWgMeshAction } from "@/server/actions/mesh";
import { Download, Network, Server, Sparkles, Spline } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { MeshPreview } from "./mesh-preview";

interface InstanceLite {
  id: string;
  name: string | null;
  providerInstanceId: string;
  provider: string;
  publicIp: string | null;
  privateIp: string | null;
}

type Tab = "wireguard" | "tailscale";

export function MeshWorkspace({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.mesh");
  const [tab, setTab] = useState<Tab>("wireguard");

  return (
    <PageShell>
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<Spline />}
        badge={<Badge variant="muted">{t("reachable", { count: instances.length })}</Badge>}
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href="/terminal">{t("openTerminal")}</Link>
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="h-auto flex-wrap justify-start" aria-label={t("title")}>
          <TabsTrigger value="wireguard" className="min-h-10 gap-1.5 sm:min-h-8">
            <Network className="size-4" aria-hidden />
            {t("tabs.wireguard")}
          </TabsTrigger>
          <TabsTrigger value="tailscale" className="min-h-10 gap-1.5 sm:min-h-8">
            <Spline className="size-4" aria-hidden />
            {t("tabs.tailscale")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="wireguard">
          <WireguardTab instances={instances} />
        </TabsContent>
        <TabsContent value="tailscale">
          <TailscaleTab instances={instances} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function WireguardTab({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.mesh");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subnet, setSubnet] = useState("10.66.0.0/24");
  const [configs, setConfigs] = useState<Record<string, string>>({});

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }, []);
  const allSelected = instances.length > 0 && selected.size === instances.length;
  const toggleAll = useCallback(() => setSelected(allSelected ? new Set() : new Set(instances.map((i) => i.id))), [allSelected, instances]);

  const generate = useAction(
    async (): Promise<ActionResult<Record<string, string>>> => {
      const peers = instances
        .filter((i) => selected.has(i.id))
        .map((i) => ({
          name: i.name?.replace(/\s+/g, "-") ?? i.providerInstanceId,
          ip: i.privateIp ?? i.publicIp ?? "",
          publicIp: i.publicIp,
          listenPort: 51820,
        }));
      const r = await generateWgMeshAction({ subnet, peers });
      return r.ok ? ok(r.configs) : toError(r);
    },
    { refresh: false, success: (cfg) => t("wireguard.generated", { count: Object.keys(cfg).length }), onSuccess: setConfigs },
  );

  const autoBuild = useAction(
    async (): Promise<ActionResult<{ configs: Record<string, string>; peerCount: number }>> => {
      const r = await autoBuildMeshFromFleetAction({ subnet, listenPort: 51820 });
      return r.ok ? ok({ configs: r.configs, peerCount: r.peerCount }) : toError(r);
    },
    { refresh: false, success: (d) => t("wireguard.autoBuilt", { count: d.peerCount }), onSuccess: (d) => setConfigs(d.configs) },
  );

  const download = (name: string, body: string) => {
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.wg0.conf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = useMemo<ColumnDef<InstanceLite, unknown>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: () => <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onCheckedChange={toggleAll} aria-label={t("wireguard.selectAll")} />,
        cell: ({ row }) => <Checkbox checked={selected.has(row.original.id)} onCheckedChange={() => toggle(row.original.id)} aria-label={t("wireguard.selectPeer", { name: row.original.name ?? row.original.providerInstanceId })} />,
      },
      {
        id: "name",
        accessorFn: (i) => i.name ?? i.providerInstanceId,
        header: t("columns.name"),
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{row.original.name ?? row.original.providerInstanceId}</span>
            <span className="truncate text-xs text-fg-muted">{row.original.provider}</span>
          </span>
        ),
      },
      { accessorKey: "publicIp", header: t("columns.publicIp"), cell: ({ row }) => <span className="font-mono text-xs">{row.original.publicIp ?? "—"}</span> },
      { accessorKey: "privateIp", header: t("columns.privateIp"), cell: ({ row }) => <span className="font-mono text-xs">{row.original.privateIp ?? "—"}</span> },
      {
        id: "endpoint",
        accessorFn: (i) => (i.publicIp ? "public" : "private"),
        header: t("columns.endpoint"),
        cell: ({ row }) => <Badge variant={row.original.publicIp ? "info" : "warning"}>{row.original.publicIp ? t("legend.public") : t("legend.private")}</Badge>,
      },
    ],
    [t, selected, allSelected, toggle, toggleAll],
  );

  const entries = Object.entries(configs);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PageSection
          title={t("wireguard.peersTitle")}
          description={t("wireguard.peersDescription")}
          action={<Badge variant={selected.size >= 2 ? "success" : "muted"}>{t("wireguard.selectedCount", { count: selected.size })}</Badge>}
        >
          <div className="mb-3 max-w-xs">
            <Field label={t("wireguard.subnet")}>
              <Input value={subnet} onChange={(e) => setSubnet(e.target.value)} className="font-mono" spellCheck={false} />
            </Field>
          </div>
          <DataTable
            columns={columns}
            data={instances}
            dense
            searchable={instances.length > 5}
            getRowId={(i) => i.id}
            onRowClick={(i) => toggle(i.id)}
            emptyState={
              <EmptyState
                compact
                icon={<Server />}
                title={t("noInstances.title")}
                description={t("noInstances.description")}
                action={
                  <Button size="sm" asChild>
                    <Link href="/instances">{t("noInstances.cta")}</Link>
                  </Button>
                }
              />
            }
          />
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => void autoBuild.run()} loading={autoBuild.pending} disabled={generate.pending}>
              <Sparkles className="size-4" aria-hidden />
              {t("wireguard.autoBuild")}
            </Button>
            <Button onClick={() => void generate.run()} loading={generate.pending} disabled={selected.size < 2 || autoBuild.pending}>
              <Network className="size-4" aria-hidden />
              {t("wireguard.generate")}
            </Button>
          </div>
        </PageSection>
        <PageSection title={t("preview.title")} description={t("preview.description")}>
          <MeshPreview peers={instances.map((i) => ({ id: i.id, label: i.name ?? i.providerInstanceId, publicIp: i.publicIp, selected: selected.has(i.id) }))} />
        </PageSection>
      </div>

      {entries.length > 0 && (
        <PageSection title={t("wireguard.configsTitle")} description={t("wireguard.configsDescription", { count: entries.length })}>
          <div className="grid gap-3 xl:grid-cols-2">
            {entries.map(([name, body], i) => (
              <m.div key={name} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }} className="min-w-0">
                <LogViewer
                  title={<span className="font-mono">{name}/wg0.conf</span>}
                  text={body}
                  height="max-h-64"
                  searchable={false}
                  autoScroll={false}
                  actions={
                    <Button variant="ghost" size="icon" className="size-8" aria-label={t("wireguard.download")} title={t("wireguard.download")} onClick={() => download(name, body)}>
                      <Download className="size-4" aria-hidden />
                    </Button>
                  }
                />
              </m.div>
            ))}
          </div>
        </PageSection>
      )}
    </div>
  );
}

function TailscaleTab({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.mesh");
  const [form, setForm] = useState({ authKey: "", hostname: "", tags: "tag:server", ssh: true, advertiseRoutes: "" });
  const [out, setOut] = useState<{ install: string; up: string } | null>(null);

  const generate = useAction(
    async (): Promise<ActionResult<{ install: string; up: string }>> => {
      const r = await generateTailscaleCommandAction({
        authKey: form.authKey,
        hostname: form.hostname || undefined,
        tags: form.tags ? form.tags.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
        ssh: form.ssh,
        advertiseRoutes: form.advertiseRoutes ? form.advertiseRoutes.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      });
      return r.ok ? ok({ install: r.install, up: r.up }) : toError(r);
    },
    { refresh: false, onSuccess: setOut },
  );

  return (
    <div className="space-y-4">
      <PageSection title={t("tailscale.title")} description={t("tailscale.description")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label={t("tailscale.authKey")}>
            <Input type="password" value={form.authKey} onChange={(e) => setForm({ ...form, authKey: e.target.value })} placeholder="tskey-auth-…" className="font-mono" autoComplete="off" />
          </Field>
          <Field label={t("tailscale.hostname")}>
            <Input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} />
          </Field>
          <Field label={t("tailscale.tags")} hint={t("tailscale.commaHint")}>
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} className="font-mono" />
          </Field>
          <Field label={t("tailscale.routes")} hint={t("tailscale.commaHint")}>
            <Input value={form.advertiseRoutes} onChange={(e) => setForm({ ...form, advertiseRoutes: e.target.value })} placeholder="10.0.0.0/16" className="font-mono" />
          </Field>
          <Field label={t("tailscale.ssh")} hint={t("tailscale.sshHint")} inline className="self-end">
            <Switch checked={form.ssh} onCheckedChange={(v) => setForm({ ...form, ssh: v })} aria-label={t("tailscale.ssh")} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => void generate.run()} loading={generate.pending} disabled={!form.authKey}>
            <Spline className="size-4" aria-hidden />
            {t("tailscale.generate")}
          </Button>
        </div>
      </PageSection>
      {out && (
        <LogViewer
          title={t("tailscale.outputTitle")}
          text={`# ${t("tailscale.installComment")}\n${out.install}\n\n# ${t("tailscale.connectComment")}\n${out.up}`}
          height="max-h-72"
          searchable={false}
          autoScroll={false}
          wrap
          lineTone={(line) => (line.startsWith("#") ? "muted" : undefined)}
        />
      )}
      <p className="text-xs text-fg-muted">{t("tailscale.runHint", { count: instances.length })}</p>
    </div>
  );
}
