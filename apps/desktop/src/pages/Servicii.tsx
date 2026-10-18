import { FolderOpen, Play, RefreshCw, ScrollText, Square } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { HealthCtx } from "../App";
import { api, cn, useAction, usePoll } from "../lib";
import { usePlatform } from "../platform";
import { Card, Stat } from "../ui";
import { Pi } from "./Pi";

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
    <div className="grid gap-8">
      <ServiciiDesktop />
      <Pi embedded />
    </div>
  );
}

function ServiciiDesktop() {
  const { t } = useTranslation();
  const health = React.useContext(HealthCtx);
  const tasks = usePoll(() => api.tasks(), 8000);
  const { busy, run } = useAction();
  const [log, setLog] = React.useState<string>("turzx");
  const [text, setText] = React.useState("");
  const tail = React.useCallback(() => api.tailLog(log, 200).then(setText).catch((e) => setText(String(e))), [log]);
  React.useEffect(() => {
    void tail();
    const id = setInterval(() => document.visibilityState === "visible" && void tail(), 4000);
    return () => clearInterval(id);
  }, [tail]);

  const list = tasks.data ?? health?.tasks ?? [];
  const running = list.filter((t) => t.running).length;
  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("nav.sistem")}</h1>
        <p className="text-sm text-muted mt-1">{t("sistem.sub")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k={t("sistem.activeTasks")} v={`${running} / ${list.length}`} tone={running === list.length ? "ok" : "warn"} />
        <Stat k="HyperHDR" v={health?.hyper ? health.source : t("sistem.down")} tone={health?.hyper ? "ok" : "down"} />
        <Stat k="vmui" v={health?.vmui ? t("sistem.responds") : t("common.off")} tone={health?.vmui ? "ok" : "warn"} />
        <Stat k="Home Assistant" v={health?.ha ? t("sistem.connected") : t("common.unavailable")} tone={health?.ha ? "ok" : "down"} />
      </div>

      <Card title={t("sistem.tasks")} right={<button type="button" className="btn ghost sm" aria-label={t("common.refresh")} onClick={() => void tasks.refresh()}><RefreshCw className="size-3.5" /></button>}>
        <div className="grid gap-2">
          {list.map((task) => {
            const l = LABEL[task.name];
            const m = l ? { name: t(`sistem.task.${l.key}.name`), what: t(`sistem.task.${l.key}.what`), log: l.log, self: l.self } : { name: task.name, what: "", log: undefined, self: false };
            return (
              <div key={task.name} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
                <span className={cn("dot", task.running ? "text-ok bg-ok" : task.status === "missing" ? "text-down bg-down" : "text-warn bg-warn")} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{m.name} <span className="text-dim font-normal">· {task.name}</span></div>
                  <div className="text-xs text-muted truncate">{m.what}</div>
                </div>
                <span className="text-xs text-muted w-16 text-right">{task.running ? t("sistem.running") : task.status === "missing" ? t("sistem.missing") : t("common.off")}</span>
                {m.log && <button type="button" className="btn ghost sm" aria-label={t("common.logFor", { name: m.name })} onClick={() => setLog(m.log!)}><ScrollText className="size-3.5" /></button>}
                {m.self ? <span className="text-xs text-dim">{t("sistem.selfHint")}</span> : task.running
                  ? <button type="button" className="btn sm" disabled={busy === task.name} onClick={() => run(task.name, () => api.taskAction(task.name, "stop").then(() => tasks.refresh()), t("sistem.stopped", { name: m.name }))}><Square className="size-3.5" />{t("common.stop")}</button>
                  : <button type="button" className="btn sm" disabled={busy === task.name || task.status === "missing"} onClick={() => run(task.name, () => api.taskAction(task.name, "start").then(() => tasks.refresh()), t("sistem.started", { name: m.name }))}><Play className="size-3.5" />{t("common.start")}</button>}
                {!m.self && <button type="button" className="btn sm" disabled={busy === task.name || task.status === "missing"} onClick={() => run(task.name, () => api.taskAction(task.name, "restart").then(() => tasks.refresh()), t("sistem.restarted", { name: m.name }))}><RefreshCw className="size-3.5" />{t("common.restart")}</button>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title={`Log · ${log}`} sub={t("sistem.logSub")}
        right={<div className="flex gap-1">{["turzx", "bridges", "hyperhdr", "openrgb", "vmui", "desktop"].map((l) => <button key={l} type="button" aria-pressed={l === log} className={cn("btn ghost sm", l === log && "on")} onClick={() => setLog(l)}>{l}</button>)}<button type="button" className="btn ghost sm" onClick={() => void api.openPath("logs")} aria-label={t("sistem.openLogs")}><FolderOpen className="size-3.5" /></button></div>}>
        <pre className="log">{text || t("common.empty")}</pre>
      </Card>
    </div>
  );
}
