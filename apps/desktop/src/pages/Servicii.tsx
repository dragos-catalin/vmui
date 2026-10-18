import { FolderOpen, Play, RefreshCw, ScrollText, Square } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { HealthCtx, HealthRefreshCtx } from "../App";
import { api, cn, useAction, useInterval } from "../lib";
import { usePlatform } from "../platform";
import { Card, Loading, PageHeader, Stat } from "../ui";
import { Pi } from "./Pi";

const LOGS = ["turzx", "bridges", "hyperhdr", "openrgb", "vmui", "desktop"];

const LABEL: Record<string, { key: "hyperhdr" | "openrgb" | "bridges" | "vmui" | "turzx" | "tray"; log?: string; self?: boolean }> = {
  "vmui-ambilight-hyperhdr": { key: "hyperhdr", log: "hyperhdr" },
  "vmui-ambilight-openrgb": { key: "openrgb", log: "openrgb" },
  "vmui-ambilight-bridges": { key: "bridges", log: "bridges" },
  "vmui-service": { key: "vmui", log: "vmui" },
  "vmui-turzx": { key: "turzx", log: "turzx" },
  "vmui-tray": { key: "tray", log: "desktop", self: true },
};

/** Sistem: local Task Scheduler stack + homepi services. On the phone only the Pi part exists. */
export function Servicii() {
  const { mobile } = usePlatform();
  if (mobile) return <Pi />;
  return (
    <div className="grid gap-5">
      <ServiciiDesktop />
      <Pi embedded />
    </div>
  );
}

function ServiciiDesktop() {
  const { t } = useTranslation();
  const health = React.useContext(HealthCtx);
  // task states come with the tray loop's `health` event (one schtasks call for everything, DK-02)
  const { refresh, busy: checking } = React.useContext(HealthRefreshCtx);
  const { busy, run } = useAction();
  const [log, setLog] = React.useState<string>("turzx");
  const [text, setText] = React.useState("");
  const tail = React.useCallback(() => api.tailLog(log, 200).then(setText).catch((e) => setText(String(e))), [log]);
  useInterval(() => void tail(), 4000);
  React.useEffect(() => void tail(), [tail]);

  const list = health?.tasks ?? [];
  const running = list.filter((t) => t.running).length;
  const after = () => refresh();
  return (
    <div className="grid gap-5">
      <PageHeader title={t("nav.sistem")} sub={t("sistem.sub")} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k={t("sistem.activeTasks")} v={`${running} / ${list.length}`} tone={running === list.length ? "ok" : "warn"} />
        <Stat k="HyperHDR" v={health?.hyper ? health.source : t("sistem.down")} tone={health?.hyper ? "ok" : "down"} />
        <Stat k="vmui" v={health?.vmui ? t("sistem.responds") : t("common.off")} tone={health?.vmui ? "ok" : "warn"} />
        <Stat k="Home Assistant" v={health?.ha ? t("sistem.connected") : t("common.unavailable")} tone={health?.ha ? "ok" : "down"} />
      </div>

      <Card title={t("sistem.tasks")} right={<button type="button" className="btn ghost sm" aria-label={t("common.refresh")} disabled={checking} onClick={refresh}><RefreshCw className={cn("size-3.5", checking && "motion-safe:animate-spin")} /></button>}>
        {!health ? <Loading /> : (
        <div className="grid gap-2">
          {list.map((task) => {
            const l = LABEL[task.name];
            const m = l ? { name: t(`sistem.task.${l.key}.name`), what: t(`sistem.task.${l.key}.what`), log: l.log, self: l.self } : { name: task.name, what: "", log: undefined, self: false };
            const status = task.running ? t("sistem.running") : task.status === "missing" ? t("sistem.missing") : t("common.off");
            return (
              <div key={task.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border px-3 py-2.5">
                <span className={cn("dot", task.running ? "text-ok bg-ok" : task.status === "missing" ? "text-down bg-down" : "text-warn bg-warn")} aria-hidden />
                <div className="min-w-0 flex-1 basis-48">
                  <div className="truncate text-sm font-medium" title={`${m.name} · ${task.name}`}>{m.name} <span className="text-muted font-normal">· {task.name}</span></div>
                  <div className="text-xs text-muted truncate" title={m.what}>{m.what}</div>
                </div>
                <span className="text-xs text-muted">{status}</span>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  {m.log && <button type="button" className="btn ghost sm" aria-label={t("common.logFor", { name: m.name })} onClick={() => setLog(m.log!)}><ScrollText className="size-3.5" /></button>}
                  {m.self ? <span className="text-xs text-muted">{t("sistem.selfHint")}</span> : task.running
                    ? <button type="button" className="btn sm" disabled={busy === task.name} onClick={() => run(task.name, () => api.taskAction(task.name, "stop").then(after), t("sistem.stopped", { name: m.name }))}><Square className="size-3.5" />{t("common.stop")}</button>
                    : <button type="button" className="btn sm" disabled={busy === task.name || task.status === "missing"} onClick={() => run(task.name, () => api.taskAction(task.name, "start").then(after), t("sistem.started", { name: m.name }))}><Play className="size-3.5" />{t("common.start")}</button>}
                  {!m.self && <button type="button" className="btn sm" disabled={busy === task.name || task.status === "missing"} onClick={() => run(task.name, () => api.taskAction(task.name, "restart").then(after), t("sistem.restarted", { name: m.name }))}><RefreshCw className="size-3.5" />{t("common.restart")}</button>}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </Card>

      <Card title={t("sistem.logTitle", { name: log })} sub={t("sistem.logSub")}
        right={<div className="flex items-center gap-1">
          <select className="input py-1.5 text-xs" value={log} onChange={(e) => setLog(e.target.value)} aria-label={t("sistem.logPick")}>
            {LOGS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button type="button" className="btn ghost sm" onClick={() => void api.openPath("logs")} aria-label={t("sistem.openLogs")}><FolderOpen className="size-3.5" /></button>
        </div>}>
        <pre className="log">{text || t("common.empty")}</pre>
      </Card>
    </div>
  );
}
