import { Lightbulb, LightbulbOff, Moon, Play, RefreshCw, Save, Sun, Trash2, Undo2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { tx } from "../i18n";
import { HealthDot, LightControls, useLights, type LightsApi } from "../light-ui";
import { cn } from "../lib";
import { roomId, stateColor, type LightDevice } from "../lights";
import { Card, Empty } from "../ui";

/** Every registry light grouped by room (+ custom groups), with scenes, undo and the day/night profile. */
export function Lumini() {
  const { t } = useTranslation();
  const lights = useLights();
  const d = lights.data;
  if (!d) return <div className="text-sm text-dim">{lights.error ? t("lights.down", { error: lights.error }) : t("common.loading")}</div>;

  const devices = d.devices.filter((x) => x.enabled);
  const rooms = Array.from(new Set([...d.rooms.map(roomId), ...devices.map((x) => x.room)])).filter((r) => devices.some((x) => x.room === r));
  const onCount = devices.filter((x) => x.state?.on).length;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("nav.lumini")}</h1>
          <p className="text-sm text-muted mt-1">
            {t("lights.summary", { on: onCount, total: devices.length })}
            {" · "}{d.pcOnline ? t("lights.pcOnline") : t("lights.pcOffline")}
            {d.haOnline === false ? ` · ${t("lights.haOffline")}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={() => void lights.set("all", { on: true })}><Lightbulb className="size-4" />{t("lights.allOn")}</button>
          <button type="button" className="btn" onClick={() => void lights.set("all", { on: false })}><LightbulbOff className="size-4" />{t("lights.allOff")}</button>
          <button type="button" className="btn ghost" disabled={lights.busy === "undo"} onClick={() => void lights.op({ op: "undo" }, { ok: t("lights.undone") }).catch(() => undefined)}><Undo2 className="size-4" />{t("common.undo")}</button>
          <button type="button" className="btn ghost sm" aria-label={t("common.refresh")} onClick={() => void lights.refresh()}><RefreshCw className="size-3.5" /></button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px]">
        <div className="grid content-start gap-5">
          {rooms.length === 0 && <Empty text={t("lights.empty")} />}
          {rooms.map((r) => <RoomCard key={r} room={r} devices={devices.filter((x) => x.room === r)} lights={lights} />)}
          {d.groups.filter((g) => g.kind !== "room").map((g) => {
            const members = new Set(g.members ?? []);
            const list = devices.filter((x) => members.has(`dev:${x.id}`) || x.segments.some((s) => members.has(`seg:${s.id}`)));
            const anyOn = list.some((x) => x.state?.on);
            return (
              <Card key={g.id} title={g.name} sub={t("lights.groupSub", { n: list.length })} right={<GroupToggle on={anyOn} label={g.name} onChange={(on) => void lights.set(`group:${g.id}`, { on })} />}>
                <div className="flex flex-wrap gap-2">{list.map((x) => <Chip key={x.id} d={x} />)}</div>
              </Card>
            );
          })}
        </div>
        <div className="grid content-start gap-5">
          <Scenes lights={lights} />
          <Profiles lights={lights} />
        </div>
      </div>
    </div>
  );
}

function GroupToggle({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
      <button type="button" className={cn("btn sm", on && "on")} aria-pressed={on} onClick={() => onChange(true)}>{t("lights.on")}</button>
      <button type="button" className={cn("btn sm", !on && "on")} aria-pressed={!on} onClick={() => onChange(false)}>{t("lights.off")}</button>
    </div>
  );
}

function Chip({ d }: { d: LightDevice }) {
  const c = stateColor(d.state);
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs">
      <span className="size-2.5 rounded-full border border-border-2 bg-bg-2" style={c ? { background: c } : undefined} aria-hidden />{d.name}
    </span>
  );
}

function RoomCard({ room, devices, lights }: { room: string; devices: LightDevice[]; lights: LightsApi }) {
  const { t } = useTranslation();
  const anyOn = devices.some((x) => x.state?.on);
  const name = tx(`rooms.${room}`, room);
  return (
    <Card title={name} sub={t("lights.roomSub", { on: devices.filter((x) => x.state?.on).length, total: devices.length })}
      right={<GroupToggle on={anyOn} label={name} onChange={(on) => void lights.set(`room:${room}`, { on })} />}>
      <ul className="grid gap-2">
        {devices.map((x) => (
          <li key={x.id} className="rounded-xl border border-border px-3 py-2.5">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium truncate">{x.name}</span>
              <span className="text-[11px] text-dim">{tx(`lights.transport.${x.transport}`, x.transport)}</span>
              <span className="ml-auto"><HealthDot d={x} ble={lights.ble[x.address.toUpperCase()]} /></span>
            </div>
            <LightControls d={x} lights={lights} compact />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Scenes({ lights }: { lights: LightsApi }) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [naming, setNaming] = React.useState(false);
  const scenes = lights.data?.scenes ?? [];
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const targets = (lights.data?.devices ?? []).filter((d) => d.enabled).map((d) => `dev:${d.id}`);
    void lights.op({ op: "scene_save", name: n, targets }, { ok: t("lights.sceneSaved", { name: n }) }).then(() => { setName(""); setNaming(false); }).catch(() => undefined);
  };
  return (
    <Card title={t("lights.scenes")} sub={t("lights.scenesSub")}>
      {scenes.length === 0 ? <div className="text-sm text-dim">{t("lights.noScenes")}</div> : (
        <ul className="grid gap-1.5">
          {scenes.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <button type="button" className="btn sm flex-1 justify-start" onClick={() => void lights.op({ op: "scene_apply", id: s.id }, { key: `scene:${s.id}`, ok: t("lights.sceneApplied", { name: s.name }) }).catch(() => undefined)} disabled={lights.busy === `scene:${s.id}`}>
                <Play className="size-3.5" />{s.name}
              </button>
              <button type="button" className="btn ghost sm hover:text-down" aria-label={t("lights.sceneDelete", { name: s.name })}
                onClick={() => { if (confirm(t("lights.sceneDeleteConfirm", { name: s.name }))) void lights.op({ op: "scene_delete", id: s.id }).catch(() => undefined); }}>
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-border pt-3">
        {naming ? (
          <form className="flex gap-2" onSubmit={save}>
            <input className="input min-w-0 flex-1" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("lights.sceneName")} aria-label={t("lights.sceneName")}
              onKeyDown={(e) => e.key === "Escape" && setNaming(false)} />
            <button type="submit" className="btn primary sm" disabled={!name.trim() || lights.busy === "scene_save"}><Save className="size-3.5" />{t("common.save")}</button>
          </form>
        ) : (
          <button type="button" className="btn sm w-full justify-center" onClick={() => setNaming(true)}><Save className="size-3.5" />{t("lights.sceneFromState")}</button>
        )}
      </div>
    </Card>
  );
}

function Profiles({ lights }: { lights: LightsApi }) {
  const { t } = useTranslation();
  const profiles = lights.data?.profiles ?? [];
  if (profiles.length === 0) return null;
  return (
    <Card title={t("lights.profiles")} sub={t("lights.profilesSub")}>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("lights.profiles")}>
        {profiles.map((p) => (
          <button key={p.id} type="button" aria-pressed={p.active} className={cn("btn sm", p.active && "on")} disabled={lights.busy === `profile:${p.id}`}
            onClick={() => void lights.op({ op: "profile_activate", id: p.id }, { key: `profile:${p.id}`, ok: t("lights.profileActive", { name: tx(`lights.profile.${p.id}`, p.name) }) }).catch(() => undefined)}>
            {p.id === "night" ? <Moon className="size-3.5" /> : p.id === "day" ? <Sun className="size-3.5" /> : null}
            {tx(`lights.profile.${p.id}`, p.name)}
          </button>
        ))}
      </div>
    </Card>
  );
}
