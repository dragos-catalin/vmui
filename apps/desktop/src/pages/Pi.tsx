import { RefreshCw, ScrollText } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { tx } from "../i18n";
import { api, cn, useAction, usePoll } from "../lib";
import { usePlatform } from "../platform";
import { Card, Stat } from "../ui";
import { DevicesCard } from "./Devices";

type PiState = {
  units: Array<{ name: string; status: string; running: boolean }>;
  containers: Array<{ name: string; status: string; running: boolean }>;
  uptimeSec: number;
  tempC: number;
  throttled: string | null;
  mem: { usedMB: number; totalMB: number };
  disk: { used: string; size: string; pct: string };
  note?: string;
};
const what = (name: string) => tx(`pi.what.${name.replace(/-/g, "_")}`, "");

/** The Raspberry Pi's services, from vmui's /api/desktop/pi (systemctl, docker, vcgencmd).
 *  Desktop goes through the `pi_status` command (shared token); the phone uses its device token. */
export function Pi({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const { mobile } = usePlatform();
  const get = React.useCallback(<T,>(log?: string) => (mobile ? api.vmuiGet<T>(`/api/desktop/pi${log ? `?log=${encodeURIComponent(log)}` : ""}`) : api.piStatus<T>(log)), [mobile]);
  const st = usePoll(() => get<PiState>(), 8000, [get]);
  const { busy, run } = useAction();
  const [log, setLog] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  React.useEffect(() => {
    if (!log) return;
    const tail = () => get<{ text: string }>(log).then((r) => setText(r.text)).catch((e) => setText(String(e)));
    void tail();
    const id = setInterval(() => document.visibilityState === "visible" && void tail(), 5000);
    return () => clearInterval(id);
  }, [log, get]);
  const s = st.data;
  if (!s || !Array.isArray(s.units)) return <div className="text-sm text-dim">{st.error ? t("pi.down", { error: st.error }) : t("common.loading")}</div>;
  const up = s.uptimeSec ? t("pi.uptimeValue", { d: Math.floor(s.uptimeSec / 86400), h: Math.floor((s.uptimeSec % 86400) / 3600) }) : "—";
  const thr = s.throttled && s.throttled !== "0x0";
  const act = (unit: string, action: "restart" | "start" | "stop") => run(unit, () => api.vmuiSend("POST", "/api/desktop/pi", { unit, action }).then(() => st.refresh()), `${unit}: ${action}`);
  return (
    <div className="grid gap-5">
      {embedded ? (
        <h2 className="text-lg font-semibold tracking-tight mt-2">Raspberry Pi <span className="text-sm font-normal text-muted">· {t("pi.sub")}</span></h2>
      ) : (
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Raspberry Pi</h1>
          <p className="text-sm text-muted mt-1">{t("pi.sub")}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k="Uptime" v={up} />
        <Stat k={t("pi.temp")} v={Number.isFinite(s.tempC) ? `${s.tempC.toFixed(1)} °C` : "—"} tone={s.tempC > 70 ? "warn" : "ok"} />
        <Stat k={t("pi.power")} v={thr ? `throttled ${s.throttled}` : "ok"} tone={thr ? "down" : "ok"} />
        <Stat k={t("pi.ramDisk")} v={`${Math.round((s.mem.usedMB / Math.max(1, s.mem.totalMB)) * 100)} % · ${s.disk.pct}`} />
      </div>
      <Card title={t("pi.units")} right={<button type="button" className="btn ghost sm" aria-label={t("common.refresh")} onClick={() => void st.refresh()}><RefreshCw className="size-3.5" /></button>}>
        <div className="grid gap-2">
          {s.units.map((u) => (
            <div key={u.name} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              <span className={cn("dot", u.running ? "text-ok bg-ok" : "text-down bg-down")} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{u.name} <span className="text-dim font-normal">· {u.status}</span></div>
                <div className="text-xs text-muted truncate">{what(u.name)}</div>
              </div>
              <button type="button" className="btn ghost sm" aria-label={t("common.logFor", { name: u.name })} onClick={() => setLog(u.name)}><ScrollText className="size-3.5" /></button>
              <button type="button" className="btn sm" disabled={busy === u.name} onClick={() => act(u.name, "restart")}><RefreshCw className="size-3.5" />{t("common.restart")}</button>
            </div>
          ))}
        </div>
      </Card>
      <Card title={t("pi.containers")}>
        <div className="grid gap-2">
          {s.containers.map((c) => (
            <div key={c.name} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              <span className={cn("dot", c.running ? "text-ok bg-ok" : "text-down bg-down")} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.name} <span className="text-dim font-normal">· {c.status}</span></div>
                <div className="text-xs text-muted truncate">{what(c.name)}</div>
              </div>
              <button type="button" className="btn ghost sm" aria-label={t("common.logFor", { name: c.name })} onClick={() => setLog(c.name)}><ScrollText className="size-3.5" /></button>
            </div>
          ))}
        </div>
      </Card>
      {mobile && <DevicesCard />}
      {log && (
        <Card title={`Log · ${log}`} sub={t("pi.logSub")} right={<button type="button" className="btn ghost sm" onClick={() => setLog(null)}>{t("common.close")}</button>}>
          <pre className="log">{text || t("common.empty")}</pre>
        </Card>
      )}
    </div>
  );
}
