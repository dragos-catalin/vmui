"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { toError } from "@/components/settings/adapt";
import { Alert, Badge, Button, DataTable, EmptyState, Field, Input, PageHeader, PageSection, PageShell, Textarea, type ColumnDef } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { helmInstallAction, installK8sAction, kubectlAction } from "@/server/actions/k8s";
import { Boxes, Download, FileText, RefreshCw, ScrollText, Server, Ship, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { InstanceSelect, type InstanceLite } from "./instance-select";

type Tab = "workloads" | "install" | "kubectl" | "helm";

export function K8sWorkspace({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.k8s");
  const [tab, setTab] = useState<Tab>("workloads");
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? "");

  if (instances.length === 0) {
    return (
      <PageShell>
        <PageHeader title={t("title")} description={t("description")} icon={<Ship />} />
        <EmptyState
          icon={<Server />}
          title={t("noInstances.title")}
          description={t("noInstances.description")}
          action={
            <Button asChild>
              <Link href="/instances">{t("noInstances.cta")}</Link>
            </Button>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<Ship />}
        actions={
          <div className="w-full min-w-56 sm:w-64">
            <InstanceSelect instances={instances} value={instanceId} onChange={setInstanceId} label={t("node")} />
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="h-auto flex-wrap justify-start" aria-label={t("title")}>
          <TabsTrigger value="workloads" className="min-h-10 gap-1.5 sm:min-h-8">
            <Boxes className="size-4" aria-hidden />
            {t("tabs.workloads")}
          </TabsTrigger>
          <TabsTrigger value="install" className="min-h-10 gap-1.5 sm:min-h-8">
            <Download className="size-4" aria-hidden />
            {t("tabs.install")}
          </TabsTrigger>
          <TabsTrigger value="kubectl" className="min-h-10 gap-1.5 sm:min-h-8">
            <Terminal className="size-4" aria-hidden />
            {t("tabs.kubectl")}
          </TabsTrigger>
          <TabsTrigger value="helm" className="min-h-10 gap-1.5 sm:min-h-8">
            <Ship className="size-4" aria-hidden />
            {t("tabs.helm")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="workloads">
          <WorkloadsTab instanceId={instanceId} />
        </TabsContent>
        <TabsContent value="install">
          <InstallTab instanceId={instanceId} />
        </TabsContent>
        <TabsContent value="kubectl">
          <KubectlTab instanceId={instanceId} />
        </TabsContent>
        <TabsContent value="helm">
          <HelmTab instanceId={instanceId} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

interface Pod {
  namespace: string;
  name: string;
  ready: string;
  status: string;
  restarts: string;
  age: string;
}

function parsePods(stdout: string): Pod[] {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0]?.trim().split(/\s+/) ?? [];
  if (!header.includes("NAME") || !header.includes("STATUS")) return [];
  const col = (name: string) => header.indexOf(name);
  const ns = col("NAMESPACE");
  const nm = col("NAME");
  const rd = col("READY");
  const st = col("STATUS");
  const rs = col("RESTARTS");
  const ag = col("AGE");
  return lines.slice(1).map((l) => {
    const c = l.trim().split(/\s+/);
    return {
      namespace: ns >= 0 ? (c[ns] ?? "") : "default",
      name: c[nm] ?? "",
      ready: rd >= 0 ? (c[rd] ?? "") : "",
      status: c[st] ?? "",
      restarts: rs >= 0 ? (c[rs] ?? "") : "",
      age: ag >= 0 ? (c[ag] ?? "") : "",
    };
  });
}

function podVariant(status: string): "success" | "warning" | "danger" | "info" | "muted" {
  if (status === "Running" || status === "Completed" || status === "Succeeded") return "success";
  if (status === "Pending" || status === "ContainerCreating" || status === "Terminating") return "info";
  if (status.includes("BackOff") || status.includes("Err") || status === "Failed" || status === "Evicted" || status === "OOMKilled") return "danger";
  if (status === "Unknown") return "muted";
  return "warning";
}

function WorkloadsTab({ instanceId }: { instanceId: string }) {
  const t = useTranslations("ops.k8s");
  const tc = useTranslations("common");
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [raw, setRaw] = useState<{ title: string; out: string; err: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useAction(
    async (): Promise<ActionResult<Pod[]>> => {
      const r = await kubectlAction(instanceId, "get pods -A");
      if (!r.ok) return toError({ error: ("error" in r ? r.error : r.stderr) || undefined });
      return ok(parsePods(r.stdout ?? ""));
    },
    { refresh: false, onSuccess: setPods },
  );

  const inspect = useAction(
    async (pod: Pod, verb: "describe" | "logs"): Promise<ActionResult<{ title: string; out: string; err: string }>> => {
      const args = verb === "describe" ? `describe pod ${pod.name} -n ${pod.namespace}` : `logs ${pod.name} -n ${pod.namespace} --tail=200`;
      const r = await kubectlAction(instanceId, args);
      const err = (!r.ok && "error" in r ? r.error : r.stderr) ?? "";
      return ok({ title: `kubectl ${args}`, out: r.stdout ?? "", err });
    },
    { refresh: false, onSuccess: setRaw },
  );

  const runInspect = useCallback(
    async (pod: Pod, verb: "describe" | "logs") => {
      setBusy(`${pod.namespace}/${pod.name}`);
      try {
        await inspect.run(pod, verb);
      } finally {
        setBusy(null);
      }
    },
    [inspect],
  );

  const columns = useMemo<ColumnDef<Pod, unknown>[]>(
    () => [
      { accessorKey: "namespace", header: t("columns.namespace"), cell: ({ row }) => <span className="font-mono text-xs text-fg-muted">{row.original.namespace}</span> },
      { accessorKey: "name", header: t("columns.name"), cell: ({ row }) => <span className="block max-w-[24rem] truncate font-medium" title={row.original.name}>{row.original.name}</span> },
      { accessorKey: "status", header: t("columns.status"), cell: ({ row }) => <Badge variant={podVariant(row.original.status)}>{row.original.status}</Badge> },
      { accessorKey: "ready", header: t("columns.ready"), cell: ({ row }) => <span className="tabular-nums">{row.original.ready}</span> },
      { accessorKey: "restarts", header: t("columns.restarts"), cell: ({ row }) => <span className="tabular-nums">{row.original.restarts}</span> },
      { accessorKey: "age", header: t("columns.age"), cell: ({ row }) => <span className="tabular-nums text-fg-muted">{row.original.age}</span> },
    ],
    [t],
  );

  return (
    <div className="space-y-4">
      <PageSection
        title={t("workloads.title")}
        description={t("workloads.description")}
        action={
          <Button size="sm" variant="secondary" onClick={() => void load.run()} loading={load.pending}>
            <RefreshCw className="size-4" aria-hidden />
            {pods ? tc("refresh") : t("workloads.load")}
          </Button>
        }
      >
        {pods === null && !load.pending ? (
          <EmptyState
            compact
            icon={<Boxes />}
            title={t("workloads.emptyTitle")}
            description={t("workloads.emptyDescription")}
            action={
              <Button size="sm" onClick={() => void load.run()}>
                <RefreshCw className="size-4" aria-hidden />
                {t("workloads.load")}
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={pods ?? []}
            loading={load.pending && pods === null}
            dense
            searchable
            getRowId={(p) => `${p.namespace}/${p.name}`}
            emptyState={<EmptyState compact icon={<Boxes />} title={t("workloads.noPods")} description={t("workloads.noPodsHint")} />}
            rowActions={(p) => (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("workloads.describe")}
                  title={t("workloads.describe")}
                  loading={inspect.pending && busy === `${p.namespace}/${p.name}`}
                  onClick={() => void runInspect(p, "describe")}
                >
                  <FileText className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("workloads.logs")}
                  title={t("workloads.logs")}
                  loading={inspect.pending && busy === `${p.namespace}/${p.name}`}
                  onClick={() => void runInspect(p, "logs")}
                >
                  <ScrollText className="size-4" aria-hidden />
                </Button>
              </>
            )}
          />
        )}
      </PageSection>
      {raw && <KubectlOutput title={raw.title} stdout={raw.out} stderr={raw.err} loading={inspect.pending} />}
    </div>
  );
}

function KubectlOutput({ title, stdout, stderr, loading }: { title: string; stdout: string; stderr: string; loading?: boolean }) {
  const t = useTranslations("ops.k8s");
  const errLines = useMemo(() => new Set(stderr ? stderr.split("\n") : []), [stderr]);
  const text = [stdout, stderr].filter(Boolean).join("\n");
  return (
    <LogViewer
      title={<span className="font-mono">{title}</span>}
      text={text}
      height="max-h-96"
      loading={loading}
      emptyLabel={t("output.empty")}
      lineTone={(line) => (errLines.has(line) ? "danger" : undefined)}
    />
  );
}

function InstallTab({ instanceId }: { instanceId: string }) {
  const t = useTranslations("ops.k8s");
  const [form, setForm] = useState({ flavor: "k3s" as "k3s" | "k0s", role: "server" as "server" | "agent", serverUrl: "", token: "" });
  const [result, setResult] = useState<{ joinToken?: string; kubeconfig?: string } | null>(null);

  const install = useAction(
    async (): Promise<ActionResult<{ joinToken?: string; kubeconfig?: string }>> => {
      const r = await installK8sAction({ instanceId, ...form });
      return r.ok ? ok({ joinToken: r.joinToken, kubeconfig: r.kubeconfig }) : toError(r);
    },
    { success: t("install.done"), refresh: false, onSuccess: setResult },
  );

  const download = () => {
    if (!result?.kubeconfig) return;
    const blob = new Blob([result.kubeconfig], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vmui-kubeconfig.yaml";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <PageSection title={t("install.title")} description={t("install.description")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label={t("install.flavor")}>
            <Select value={form.flavor} onValueChange={(v) => setForm({ ...form, flavor: v as "k3s" | "k0s" })}>
              <SelectTrigger aria-label={t("install.flavor")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="k3s">k3s</SelectItem>
                <SelectItem value="k0s">k0s</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("install.role")}>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as "server" | "agent" })}>
              <SelectTrigger aria-label={t("install.role")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="server">{t("install.roleServer")}</SelectItem>
                <SelectItem value="agent">{t("install.roleAgent")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.role === "agent" && (
            <>
              <Field label={t("install.serverUrl")} hint={t("install.serverUrlHint")}>
                <Input value={form.serverUrl} onChange={(e) => setForm({ ...form, serverUrl: e.target.value })} placeholder="https://10.0.0.5:6443" className="font-mono" />
              </Field>
              <Field label={t("install.token")} className="sm:col-span-2">
                <Input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} className="font-mono" autoComplete="off" />
              </Field>
            </>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => void install.run()} loading={install.pending} disabled={!instanceId}>
            <Download className="size-4" aria-hidden />
            {t("install.submit")}
          </Button>
        </div>
      </PageSection>
      {result?.joinToken && <LogViewer title={t("install.joinToken")} text={result.joinToken} height="max-h-32" searchable={false} wrap />}
      {result?.kubeconfig && (
        <LogViewer
          title={t("install.kubeconfig")}
          text={result.kubeconfig}
          height="max-h-80"
          actions={
            <Button variant="ghost" size="icon" className="size-8" aria-label={t("install.download")} title={t("install.download")} onClick={download}>
              <Download className="size-4" aria-hidden />
            </Button>
          }
        />
      )}
    </div>
  );
}

function KubectlTab({ instanceId }: { instanceId: string }) {
  const t = useTranslations("ops.k8s");
  const [args, setArgs] = useState("get nodes");
  const [out, setOut] = useState<{ stdout: string; stderr: string } | null>(null);

  const run = useAction(
    async (): Promise<ActionResult<{ stdout: string; stderr: string }>> => {
      const r = await kubectlAction(instanceId, args);
      return ok({ stdout: r.stdout ?? "", stderr: (!r.ok && "error" in r ? r.error : r.stderr) ?? "" });
    },
    { refresh: false, onSuccess: setOut },
  );

  return (
    <div className="space-y-4">
      <PageSection title={t("kubectl.title")} description={t("kubectl.description")}>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run.run();
          }}
        >
          <Field label={t("kubectl.args")} hint={t("kubectl.argsHint")} className="flex-1">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-sm text-fg-muted" aria-hidden>
                kubectl
              </span>
              <Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono" spellCheck={false} />
            </div>
          </Field>
          <Button type="submit" loading={run.pending} disabled={!instanceId || !args.trim()} className="sm:mb-5">
            <Terminal className="size-4" aria-hidden />
            {t("kubectl.run")}
          </Button>
        </form>
      </PageSection>
      {(out || run.pending) && <KubectlOutput title={`kubectl ${args}`} stdout={out?.stdout ?? ""} stderr={out?.stderr ?? ""} loading={run.pending} />}
    </div>
  );
}

function HelmTab({ instanceId }: { instanceId: string }) {
  const t = useTranslations("ops.k8s");
  const [form, setForm] = useState({ release: "", chart: "", namespace: "", repoName: "", repoUrl: "", values: "" });
  const [message, setMessage] = useState<string | null>(null);

  const install = useAction(
    async (): Promise<ActionResult<string>> => {
      const r = await helmInstallAction({ instanceId, ...form });
      return r.ok ? ok(r.message) : toError(r);
    },
    { success: t("helm.done"), refresh: false, onSuccess: setMessage },
  );

  return (
    <div className="space-y-4">
      <PageSection title={t("helm.title")} description={t("helm.description")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label={t("helm.release")}>
            <Input value={form.release} onChange={(e) => setForm({ ...form, release: e.target.value })} />
          </Field>
          <Field label={t("helm.chart")}>
            <Input value={form.chart} onChange={(e) => setForm({ ...form, chart: e.target.value })} placeholder="bitnami/nginx" className="font-mono" />
          </Field>
          <Field label={t("helm.namespace")}>
            <Input value={form.namespace} onChange={(e) => setForm({ ...form, namespace: e.target.value })} className="font-mono" />
          </Field>
          <Field label={t("helm.repoName")}>
            <Input value={form.repoName} onChange={(e) => setForm({ ...form, repoName: e.target.value })} />
          </Field>
          <Field label={t("helm.repoUrl")} className="xl:col-span-2">
            <Input value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} className="font-mono" />
          </Field>
          <Field label={t("helm.values")} className="sm:col-span-2 xl:col-span-3">
            <Textarea value={form.values} onChange={(e) => setForm({ ...form, values: e.target.value })} className="h-32 font-mono text-xs" spellCheck={false} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => void install.run()} loading={install.pending} disabled={!instanceId || !form.release || !form.chart}>
            <Ship className="size-4" aria-hidden />
            {t("helm.submit")}
          </Button>
        </div>
      </PageSection>
      {message && (
        <Alert tone="success" title={t("helm.done")}>
          <LogViewer text={message} height="max-h-60" searchable={false} className="mt-2" />
        </Alert>
      )}
    </div>
  );
}
