import { Lock, MonitorOff, Moon, Power, RefreshCw, Snowflake, Volume2, VolumeX, Wrench } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { api, useAction } from "../lib";
import { usePlatform } from "../platform";
import { Card, confirmDialog, Empty, PageHeader, Row, Slider, StaleBadge } from "../ui";
import { useDisplayState } from "./display-state";

export function Pc() {
  const { t } = useTranslation();
  const { busy, run } = useAction();
  const { mobile, version } = usePlatform();
  const [vol, setVol] = React.useState(30);
  // vmui_get targets homepi, so this is what the Pi's turzx agent reports for every PC
  const metrics = useDisplayState(5000);

  const act = (a: string, ok?: string, v?: number) => run(a, () => api.pcAction(a, v), ok);
  const pcs = Object.entries(metrics.data?.pcs ?? {});
  const sleep = async () => { if (await confirmDialog({ title: t("pc.sleepConfirm"), confirm: t("pc.sleep") })) void act("sleep"); };
  const maint: Array<[string, string, React.ReactNode]> = [
    ["restart_tunnel", "pc.restartTunnel", <RefreshCw key="i" className="size-4" />],
    ["kill_runaway_renderer", "pc.killRenderer", <Wrench key="i" className="size-4" />],
    ["restart_ambilight", "pc.restartAmbilight", <Power key="i" className="size-4" />],
    ["restart_turzx", "pc.restartTurzx", <Power key="i" className="size-4" />],
    ["restart_vmui", "pc.restartVmui", <Power key="i" className="size-4" />],
  ];

  return (
    <div className="grid gap-5">
      <PageHeader title={t("nav.pc")} sub={mobile ? t("pc.subMobile") : t("pc.sub")} />

      {/* container queries: the content column is 640-1080 px whatever the window (DK-20) */}
      <div className="@container">
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          <button type="button" className="tile" onClick={() => act("lock")} disabled={!!busy}><Lock className="size-5 text-primary-text" /><div className="min-w-0"><div className="font-medium break-words">{t("pc.lock")}</div><div className="text-xs text-muted">Win+L</div></div></button>
          <button type="button" className="tile" onClick={() => act("display_off")} disabled={!!busy}><MonitorOff className="size-5 text-primary-text" /><div className="min-w-0"><div className="font-medium break-words">{t("pc.displayOff")}</div><div className="text-xs text-muted">{t("pc.displayOffHint")}</div></div></button>
          <button type="button" className="tile" onClick={() => void sleep()} disabled={!!busy}><Moon className="size-5 text-warning-text" /><div className="min-w-0"><div className="font-medium break-words">{t("pc.sleep")}</div><div className="text-xs text-muted">{t("pc.sleepHint")}</div></div></button>
          <button type="button" className="tile" onClick={() => act("unfreeze_vscode", t("pc.unfrozen"))} disabled={!!busy}><Snowflake className="size-5 text-info" /><div className="min-w-0"><div className="font-medium break-words">{t("pc.unfreeze")}</div><div className="text-xs text-muted">{t("pc.unfreezeHint")}</div></div></button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title={t("pc.sound")}>
          <div className="field"><span>{t("pc.volume")} · {vol} %</span><Slider value={vol} min={0} max={100} onChange={setVol} onCommit={(v) => act("volume", undefined, v)} format={(v) => `${v} %`} /></div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={() => act("mute", t("pc.muted"))} disabled={!!busy}><VolumeX className="size-4" />{t("pc.mute")}</button>
            <button type="button" className="btn" onClick={() => act("unmute", t("pc.unmuted"))} disabled={!!busy}><Volume2 className="size-4" />{t("pc.unmute")}</button>
          </div>
        </Card>
        <Card title={t("pc.maintenance")}>
          <div className="flex flex-wrap gap-2">
            {maint.map(([a, k, icon]) => <button key={a} type="button" className="btn" onClick={() => act(a, t("common.done"))} disabled={!!busy}>{icon}{t(k as "pc.restartTunnel")}</button>)}
          </div>
        </Card>
      </div>

      <Card title={t("pc.running")} sub={t("pc.runningSub")} right={<div className="flex items-center gap-2">{metrics.stale && <StaleBadge error={metrics.error} />}<button type="button" className="btn ghost sm" aria-label={t("common.refresh")} onClick={() => void metrics.refresh()}><RefreshCw className="size-3.5" /></button></div>}>
        {pcs.length === 0 ? <Empty text={metrics.error ? `${t("pc.nothing")} · ${metrics.error}` : t("pc.nothing")} illustration={metrics.error ? "offline" : "devices"} /> : (
          <div className="@container grid grid-cols-1 gap-3 @xl:grid-cols-2">
            {pcs.map(([host, m]) => (
              <div key={host} className="min-w-0 rounded-xl border border-border p-3">
                <div className="flex items-baseline justify-between gap-2"><div className="min-w-0 truncate font-medium" title={host}>{host}</div><div className="text-xs text-muted">{m.uptime != null ? t("pc.uptime", { h: Math.floor(m.uptime / 3600) }) : ""}</div></div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  {[["CPU", m.cpu], ["RAM", m.ram], ["GPU", m.gpu]].map(([k, v]) => (
                    <div key={String(k)}><div className="text-xs text-muted">{k}</div><div className="text-lg tabular-nums">{typeof v === "number" ? `${Math.round(v)} %` : "—"}</div></div>
                  ))}
                </div>
                {m.focus?.title && <div className="mt-2 text-xs text-muted truncate" title={m.focus.title}>{m.focus.proc} · {m.focus.title}</div>}
              </div>
            ))}
          </div>
        )}
      </Card>
      {mobile && <Card title={t("setari.app")}><Row label={t("setari.version")}><span className="text-xs text-muted">{version || "—"}</span></Row></Card>}
    </div>
  );
}
