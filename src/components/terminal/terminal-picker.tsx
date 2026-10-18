"use client";

import { TerminalView } from "@/components/instances/terminal-view-lazy";
import { Button, EmptyState, Field, ToggleGroup } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEventSource } from "@/hooks/use-poll";
import { openContainerTerminalAction, openHostTerminalAction } from "@/server/actions/terminal";
import { Container as ContainerIcon, Server, TerminalSquare, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

interface InstanceLite {
  id: string;
  name: string | null;
  providerInstanceId: string;
  provider: string;
  region: string;
  publicIp: string | null;
}

type Shell = "/bin/sh" | "/bin/bash";
type Target = { kind: "host"; instanceId: string } | { kind: "container"; instanceId: string; containerId: string; shell: Shell };

interface Session {
  id: string;
  wsUrl: string;
  label: string;
  target: Target;
}

export function TerminalPicker({ instances }: { instances: InstanceLite[] }) {
  const t = useTranslations("ops.terminal");
  const [mode, setMode] = useState<"host" | "container">("host");
  const [instanceId, setInstanceId] = useState<string>(instances[0]?.id ?? "");
  const [containerId, setContainerId] = useState<string>("");
  const [shell, setShell] = useState<Shell>("/bin/sh");
  const [containerOptions, setContainerOptions] = useState<{ id: string; name: string }[]>([]);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [opening, startOpen] = useTransition();

  // Deep-link: read ?instance=…&container=… on first paint to preselect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const i = sp.get("instance");
    const c = sp.get("container");
    if (i && instances.some((x) => x.id === i)) setInstanceId(i);
    if (c) {
      setMode("container");
      setContainerId(c);
    }
  }, [instances]);

  const containersUrl = mode === "container" && instanceId ? `/api/instances/${encodeURIComponent(instanceId)}/containers/stream?interval=10` : null;
  useEffect(() => {
    if (!containersUrl) return;
    setLoadingContainers(true);
    setContainerOptions([]);
  }, [containersUrl]);
  useEventSource<{ rows?: { id: string; name: string; state: string }[] }>(containersUrl, {
    events: ["snapshot"],
    onMessage: (data) => {
      const running = (data.rows ?? []).filter((r) => r.state === "running");
      setContainerOptions(running.map((r) => ({ id: r.id, name: r.name || r.id })));
      if (running.length > 0) setContainerId((cur) => cur || running[0]!.id);
      setLoadingContainers(false);
    },
    onError: () => setLoadingContainers(false),
  });

  const issue = async (target: Target) =>
    target.kind === "host"
      ? openHostTerminalAction({ instanceId: target.instanceId })
      : openContainerTerminalAction({ instanceId: target.instanceId, containerId: target.containerId, shell: target.shell });

  const open = () =>
    startOpen(async () => {
      if (mode === "container" && !containerId) {
        toast.error(t("pickContainer"));
        return;
      }
      const target: Target =
        mode === "host" ? { kind: "host", instanceId } : { kind: "container", instanceId, containerId, shell };
      const res = await issue(target);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const session: Session = { id: res.sessionId, wsUrl: res.wsUrl, label: res.label, target };
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
    });

  const reconnect = (session: Session) =>
    startOpen(async () => {
      const res = await issue(session.target);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, wsUrl: res.wsUrl, label: res.label } : s)));
    });

  const close = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? "");
      return next;
    });
  };

  if (instances.length === 0) {
    return (
      <EmptyState
        icon={<Server />}
        title={t("noHosts.title")}
        description={t("noHosts.description")}
        action={
          <Button asChild>
            <Link href="/instances/new">{t("noHosts.action")}</Link>
          </Button>
        }
        className="h-full"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="surface flex flex-wrap items-end gap-3 p-3">
        <Field label={t("target")}>
          <ToggleGroup
            value={mode}
            onValueChange={setMode}
            size="sm"
            aria-label={t("target")}
            options={[
              { value: "host", label: t("modes.host"), icon: <Server className="size-3.5" aria-hidden /> },
              { value: "container", label: t("modes.container"), icon: <ContainerIcon className="size-3.5" aria-hidden /> },
            ]}
          />
        </Field>
        <Field label={t("instance")} className="w-full sm:w-64">
          <Select value={instanceId} onValueChange={setInstanceId}>
            <SelectTrigger aria-label={t("instance")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {instances.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name ?? i.providerInstanceId} · {i.provider}/{i.region}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {mode === "container" && (
          <>
            <Field label={t("container")} className="w-full sm:w-56">
              <Select value={containerId} onValueChange={setContainerId} disabled={loadingContainers || containerOptions.length === 0}>
                <SelectTrigger aria-label={t("container")}>
                  <SelectValue placeholder={loadingContainers ? t("loadingContainers") : t("noRunningContainers")} />
                </SelectTrigger>
                <SelectContent>
                  {containerOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("shell")} className="w-full sm:w-36">
              <Select value={shell} onValueChange={(v) => setShell(v as Shell)}>
                <SelectTrigger aria-label={t("shell")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="/bin/sh">/bin/sh</SelectItem>
                  <SelectItem value="/bin/bash">/bin/bash</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </>
        )}
        <Button className="sm:ml-auto" onClick={open} loading={opening} disabled={mode === "container" && !containerId}>
          <TerminalSquare className="size-4" aria-hidden /> {t("open")}
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {sessions.length === 0 ? (
          <EmptyState icon={<TerminalSquare />} title={t("empty.title")} description={t("empty.description")} className="h-full" />
        ) : (
          <Tabs value={activeId} onValueChange={setActiveId} className="flex h-full min-h-0 flex-col gap-2">
            <TabsList aria-label={t("sessions")} className="h-auto w-full flex-wrap justify-start gap-1">
              {sessions.map((s) => (
                <span key={s.id} className="inline-flex items-center">
                  <TabsTrigger value={s.id} className="max-w-[16rem] gap-1.5" title={s.label}>
                    {s.target.kind === "host" ? (
                      <Server className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <ContainerIcon className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">{s.label}</span>
                  </TabsTrigger>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="sm:size-7"
                    aria-label={t("closeSession", { label: s.label })}
                    onClick={() => close(s.id)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </span>
              ))}
            </TabsList>
            {sessions.map((s) => (
              <TabsContent key={s.id} value={s.id} forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
                <TerminalView key={s.wsUrl} wsUrl={s.wsUrl} label={s.label} onReconnect={() => reconnect(s)} />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>
    </div>
  );
}
