import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CloudDownload, Download, Eye, Plus, Radar, Ruler, Save, Trash2, Upload, Zap } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { tx } from "../i18n";
import { HealthDot, LightControls, StripPreview, useLights, type LightsApi } from "../light-ui";
import { api, cn, toast } from "../lib";
import { bisectNext, COLOR_ORDERS, normMac, roomId, slugFor, TRANSPORTS, withSegmentStarts, type Calibration, type ColorOrder, type Discovered, type LightDevice, type LightsPayload, type Rgb, type Segment } from "../lights";
import { Card, confirmDialog, Dialog, Empty, ErrorState, Loading, PageHeader, Row, Slider, Switch } from "../ui";

type Filter = { room: string; transport: string; health: string };
const ALL = "*";

/** Registry management: every device, its calibration and segments, BLE scan, HA sync, export/import. */
export function Dispozitive() {
  const { t } = useTranslation();
  const lights = useLights(8000);
  const [sel, setSel] = React.useState<string | null>(null);
  const [f, setF] = React.useState<Filter>({ room: ALL, transport: ALL, health: ALL });
  const [scan, setScan] = React.useState(false);
  const d = lights.data;
  if (!d) return lights.error ? <ErrorState title={t("lights.downTitle")} error={lights.error} onRetry={() => void lights.refresh()} /> : <Loading />;

  const rooms = Array.from(new Set([...d.rooms.map(roomId), ...d.devices.map((x) => x.room)]));
  const shown = d.devices.filter((x) => (f.room === ALL || x.room === f.room) && (f.transport === ALL || x.transport === f.transport) && (f.health === ALL || x.health === f.health));
  const cur = d.devices.find((x) => x.id === sel) ?? shown[0] ?? null;

  return (
    <div className="grid gap-5">
      <PageHeader title={t("nav.dispozitive")} sub={t("dev.sub", { n: d.devices.length })} actions={<Toolbar lights={lights} onScan={() => setScan(true)} />} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
        <Card className="content-start self-start">
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            <FilterSelect label={t("dev.room")} value={f.room} onChange={(room) => setF({ ...f, room })} options={rooms.map((r) => [r, tx(`rooms.${r}`, r)])} />
            <FilterSelect label={t("dev.transport")} value={f.transport} onChange={(transport) => setF({ ...f, transport })} options={TRANSPORTS.map((r) => [r, tx(`lights.transport.${r}`, r)])} />
            <FilterSelect label={t("dev.health")} value={f.health} onChange={(health) => setF({ ...f, health })} options={["ok", "degraded", "offline", "unknown"].map((r) => [r, tx(`lights.health.${r}`, r)])} />
          </div>
          {shown.length === 0 ? <Empty text={t("dev.noneMatch")} illustration="search" /> : (
            <ul className="grid gap-1" aria-label={t("nav.dispozitive")}>
              {shown.map((x) => (
                <li key={x.id}>
                  <button type="button" aria-current={cur?.id === x.id ? "true" : undefined} onClick={() => setSel(x.id)}
                    className={cn("flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors", cur?.id === x.id ? "border-border-2 bg-surface-2" : "border-transparent hover:bg-surface")}>
                    <span className={cn("dot", x.health === "ok" ? "text-ok bg-ok" : x.health === "degraded" ? "text-warn bg-warn" : x.health === "offline" ? "text-down bg-down" : "text-dim bg-dim")} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm", !x.enabled && "text-muted line-through")} title={x.name}>{x.name}</span>
                      <span className="block truncate text-xs text-muted">{tx(`rooms.${x.room}`, x.room)} · {tx(`lights.transport.${x.transport}`, x.transport)}{x.segments.length > 1 ? ` · ${t("dev.segCount", { count: x.segments.length })}` : ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {cur ? <Detail key={cur.id} d={cur} rooms={rooms} lights={lights} onDeleted={() => setSel(null)} /> : <Empty text={t("dev.pick")} illustration="devices" />}
      </div>

      {scan && <ScanDialog payload={d} lights={lights} onClose={() => setScan(false)} onAdded={(id) => setSel(id)} />}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  const { t } = useTranslation();
  return (
    <label className="field min-w-0">
      <span className="truncate">{label}</span>
      <select className="input px-2 py-1.5 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={ALL}>{t("dev.any")}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Toolbar({ lights, onScan }: { lights: LightsApi; onScan: () => void }) {
  const { t } = useTranslation();
  const file = React.useRef<HTMLInputElement>(null);
  const exportJson = () => {
    if (!lights.data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(toExport(lights.data), null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vmui-lights-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const importJson = async (fl: File | undefined) => {
    if (!fl) return;
    const text = await fl.text();
    try { JSON.parse(text); } catch { return toast("error", t("dev.importInvalid")); }
    await lights.op({ op: "import", json: text }, { ok: t("dev.imported") }).catch(() => undefined);
    if (file.current) file.current.value = "";
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn primary" onClick={onScan}><Radar className="size-4" />{t("dev.scanAdd")}</button>
      <button type="button" className="btn" disabled={lights.busy === "seed_ha"} onClick={() => void lights.op({ op: "seed_ha" }, { ok: t("dev.seeded") }).catch(() => undefined)}><CloudDownload className="size-4" />{t("dev.seedHa")}</button>
      <button type="button" className="btn ghost" onClick={exportJson}><Download className="size-4" />{t("dev.export")}</button>
      <button type="button" className="btn ghost" onClick={() => file.current?.click()}><Upload className="size-4" />{t("dev.import")}</button>
      <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label={t("dev.import")} tabIndex={-1} onChange={(e) => void importJson(e.target.files?.[0])} />
    </div>
  );
}

/** Registry export shape (registryExportSchema v1, same as GET /api/lights?export=1), built from the live payload. */
function toExport(p: LightsPayload) {
  return {
    version: 1,
    devices: p.devices.map((d) => ({
      id: d.id, name: d.name, room: d.room, transport: d.transport, address: d.address, protocol: d.protocol, haEntity: d.haEntity ?? null,
      capabilities: d.capabilities, calibration: d.calibration, ledCount: d.ledCount, enabled: d.enabled,
      segments: d.segments.map((s) => ({ id: s.id, ord: s.ord, name: s.name, ledCount: s.ledCount, reverse: s.reverse, calibration: s.calibration })),
    })),
    groups: p.groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind ?? "custom", members: g.members ?? [] })),
    scenes: p.scenes.filter((s) => s.entries).map((s) => ({ id: s.id, name: s.name, entries: s.entries })),
    profiles: p.profiles.map((x) => ({ id: x.id, name: x.name, calibration: x.calibration, active: x.active })),
  };
}

function Detail({ d, rooms, lights, onDeleted }: { d: LightDevice; rooms: string[]; lights: LightsApi; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(d.name);
  const [room, setRoom] = React.useState(d.room);
  const [wizard, setWizard] = React.useState(false);
  const dirty = name.trim() !== d.name || room.trim() !== d.room;
  const update = (patch: Record<string, unknown>, ok?: string) => lights.op({ op: "device_update", id: d.id, patch }, { ok: ok ?? t("common.saved") }).catch(() => undefined);
  const segments = withSegmentStarts(d.segments);

  return (
    <div className="grid content-start gap-5">
      <Card title={d.name} sub={`${tx(`lights.transport.${d.transport}`, d.transport)} · ${d.address}${d.protocol ? ` · ${d.protocol}` : ""}`}
        right={<div className="flex items-center gap-3"><HealthDot d={d} ble={lights.ble[d.address.toUpperCase()]} /><Switch checked={d.enabled} label={t("dev.enabled")} onChange={(v) => { lights.patchDevices((x) => x.id === d.id, (x) => ({ ...x, enabled: v })); void update({ enabled: v }, v ? t("dev.enabledOn") : t("dev.enabledOff")); }} /></div>}>
        {d.lastError && <p className="mb-3 rounded-xl border border-down/40 px-3 py-2 text-xs text-down">{d.lastError}</p>}
        <LightControls d={d} lights={lights} />
        <form className="mt-4 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (dirty && name.trim() && room.trim()) void update({ name: name.trim(), room: room.trim() }); }}>
          <label className="field"><span>{t("dev.name")}</span><input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>{t("dev.room")}</span>
            <input className="input" list="dev-rooms" value={room} maxLength={40} onChange={(e) => setRoom(e.target.value)} />
            <datalist id="dev-rooms">{rooms.map((r) => <option key={r} value={r}>{tx(`rooms.${r}`, r)}</option>)}</datalist>
          </label>
          <button type="submit" className="btn primary" disabled={!dirty || !name.trim() || !room.trim()}><Save className="size-4" />{t("common.save")}</button>
        </form>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <span className="text-xs text-muted">{t("dev.caps")}:</span>
          {capList(d).map((c) => <span key={c} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{c}</span>)}
          <button type="button" className="btn ghost sm ml-auto hover:text-down" onClick={() => void confirmDialog({ title: t("dev.deleteConfirm", { name: d.name }), confirm: t("dev.delete"), danger: true }).then((ok) => { if (ok) void lights.op({ op: "device_delete", id: d.id }, { ok: t("dev.deleted", { name: d.name }) }).then(onDeleted).catch(() => undefined); })}>
            <Trash2 className="size-3.5" />{t("dev.delete")}
          </button>
        </div>
      </Card>

      <Card title={t("dev.calibration")} sub={t("dev.calibrationSub")}>
        <CalibrationEditor value={d.calibration} onPreview={(cal) => preview(lights, `dev:${d.id}`, cal, d.capabilities.whiteOnly)}
          onSave={(cal) => void update({ calibration: cal }, t("dev.calibrationSaved"))} />
      </Card>

      {d.capabilities.segments && (
        <Card title={t("dev.segments")} sub={t("dev.segmentsSub", { total: segments.reduce((a, s) => a + s.ledCount, 0), n: segments.length })}
          right={d.capabilities.ledCountConfig ? <button type="button" className="btn sm" onClick={() => setWizard(true)} disabled={segments.length === 0}><Ruler className="size-3.5" />{t("wizard.open")}</button> : undefined}>
          <StripPreview d={d} segments={segments} className="mb-4 h-3" />
          <SegmentsEditor d={d} segments={segments} lights={lights} />
        </Card>
      )}

      {wizard && <LedWizard d={d} segments={segments} lights={lights} onClose={() => setWizard(false)} />}
    </div>
  );
}

function capList(d: LightDevice): string[] {
  const c = d.capabilities;
  const out: string[] = [];
  const t = (k: string) => tx(`dev.cap.${k}`, k);
  if (c.brightness) out.push(t("brightness"));
  if (c.rgb && !c.whiteOnly) out.push(t("rgb"));
  if (c.whiteOnly) out.push(t("whiteOnly"));
  if (c.kelvin) out.push(`${c.kelvin[0]}–${c.kelvin[1]} K`);
  if (c.effects.length) out.push(`${t("effects")} · ${c.effects.length}`);
  if (c.addressable) out.push(t("addressable"));
  if (c.segments) out.push(t("segments"));
  if (c.ledCountConfig) out.push(t("ledCountConfig"));
  return out;
}

/* ------------------------------------------------------------- calibration */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Same math as the server's applyCalibration: gains -> gamma -> wire colour order -> clamp. */
function applyCalibration(rgb: Rgb, cal: Calibration): Rgb {
  const g = cal.gains ?? [1, 1, 1];
  const gamma = cal.gamma ?? 1;
  const lin = rgb.map((v, i) => clamp(v * (g[i] ?? 1), 0, 255));
  const corr = lin.map((v) => (gamma === 1 ? v : Math.pow(v / 255, gamma) * 255));
  const idx = { R: 0, G: 1, B: 2 } as const;
  const wire = [...(cal.colorOrder ?? "RGB")].map((c) => corr[idx[c as keyof typeof idx]] ?? 0);
  return [Math.round(clamp(wire[0] ?? 0, 0, 255)), Math.round(clamp(wire[1] ?? 0, 0, 255)), Math.round(clamp(wire[2] ?? 0, 0, 255))];
}

/** White at full brightness with the edited calibration applied client-side (the saved one still applies on top server-side). */
function preview(lights: LightsApi, target: string, cal: Calibration, whiteOnly: boolean) {
  const bri = Math.round(clamp(100, (cal.briMin ?? 0) * 100, (cal.briCap ?? 1) * 100));
  return lights.set(target, whiteOnly ? { on: true, brightnessPct: bri, kelvin: 4000 + (cal.kelvinOffset ?? 0) } : { on: true, brightnessPct: bri, rgb: applyCalibration([255, 255, 255], cal) });
}

/** Drop defaults so the stored JSON stays minimal and "inherit" keeps meaning inherit. */
function clean(c: Calibration): Calibration {
  const out: Calibration = {};
  if (c.gamma !== undefined && c.gamma !== 1) out.gamma = c.gamma;
  if (c.gains && c.gains.some((g) => g !== 1)) out.gains = c.gains;
  if (c.briMin !== undefined && c.briMin > 0) out.briMin = c.briMin;
  if (c.briCap !== undefined && c.briCap < 1) out.briCap = c.briCap;
  if (c.colorOrder && c.colorOrder !== "RGB") out.colorOrder = c.colorOrder;
  if (c.kelvinOffset) out.kelvinOffset = c.kelvinOffset;
  return out;
}

function CalibrationEditor({ value, onSave, onPreview }: { value: Calibration; onSave: (c: Calibration) => void; onPreview: (c: Calibration) => void }) {
  const { t } = useTranslation();
  const [c, setC] = React.useState<Calibration>(value);
  React.useEffect(() => setC(value), [value]);
  const gains = c.gains ?? [1, 1, 1];
  const dirty = JSON.stringify(clean(c)) !== JSON.stringify(clean(value));
  const setGain = (i: number, v: number) => setC({ ...c, gains: gains.map((g, j) => (j === i ? v : g)) as Rgb });
  const ch = ["R", "G", "B"];
  return (
    <div className="grid gap-1">
      <Row label={t("cal.gamma")} hint={t("cal.gammaHint")}><div className="w-full min-w-40 max-w-56"><Slider value={c.gamma ?? 1} min={0.5} max={3} step={0.05} onChange={(v) => setC({ ...c, gamma: v })} format={(v) => v.toFixed(2)} /></div></Row>
      {gains.map((g, i) => (
        <Row key={i} label={t("cal.gain", { ch: ch[i] })}><div className="w-full min-w-40 max-w-56"><Slider value={g} min={0} max={2} step={0.01} onChange={(v) => setGain(i, v)} format={(v) => v.toFixed(2)} /></div></Row>
      ))}
      <Row label={t("cal.briMin")} hint={t("cal.briMinHint")}><div className="w-full min-w-40 max-w-56"><Slider value={Math.round((c.briMin ?? 0) * 100)} min={0} max={100} onChange={(v) => setC({ ...c, briMin: Math.min(v / 100, c.briCap ?? 1) })} format={(v) => `${v} %`} /></div></Row>
      <Row label={t("cal.briCap")} hint={t("cal.briCapHint")}><div className="w-full min-w-40 max-w-56"><Slider value={Math.round((c.briCap ?? 1) * 100)} min={1} max={100} onChange={(v) => setC({ ...c, briCap: Math.max(v / 100, c.briMin ?? 0) })} format={(v) => `${v} %`} /></div></Row>
      <Row label={t("cal.colorOrder")} hint={t("cal.colorOrderHint")}>
        <select className="input py-1.5 text-xs" aria-label={t("cal.colorOrder")} value={c.colorOrder ?? "RGB"} onChange={(e) => setC({ ...c, colorOrder: e.target.value as ColorOrder })}>
          {COLOR_ORDERS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Row>
      <Row label={t("cal.kelvinOffset")}><div className="w-full min-w-40 max-w-56"><Slider value={c.kelvinOffset ?? 0} min={-1500} max={1500} step={50} onChange={(v) => setC({ ...c, kelvinOffset: v })} format={(v) => `${v > 0 ? "+" : ""}${v} K`} /></div></Row>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn ghost sm" onClick={() => setC({})}>{t("cal.reset")}</button>
        <button type="button" className="btn sm" onClick={() => onPreview(clean(c))}><Eye className="size-3.5" />{t("cal.preview")}</button>
        <button type="button" className="btn primary sm" disabled={!dirty} onClick={() => onSave(clean(c))}><Save className="size-3.5" />{t("common.save")}</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- segments */

function SegmentsEditor({ d, segments, lights }: { d: LightDevice; segments: Segment[]; lights: LightsApi }) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [count, setCount] = React.useState(30);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= segments.length) return;
    const order = segments.map((s) => s.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    void lights.op({ op: "segment_reorder", deviceId: d.id, order }).catch(() => undefined);
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || count < 1) return;
    void lights.op({ op: "segment_add", deviceId: d.id, name: name.trim(), ledCount: count }, { ok: t("seg.added", { name: name.trim() }) }).then(() => setName("")).catch(() => undefined);
  };
  return (
    <div className="grid gap-2">
      <ol className="grid gap-2">
        {segments.map((s, i) => <SegmentRow key={s.id} d={d} s={s} first={i === 0} last={i === segments.length - 1} lights={lights} onMove={(dir) => move(i, dir)} />)}
      </ol>
      <form className="mt-2 grid grid-cols-[1fr_110px_auto] items-end gap-2 border-t border-border pt-3" onSubmit={add}>
        <label className="field"><span>{t("seg.newName")}</span><input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t("seg.namePlaceholder")} /></label>
        <label className="field"><span>{t("seg.leds")}</span><input className="input" type="number" min={1} max={5000} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} /></label>
        <button type="submit" className="btn" disabled={!name.trim() || lights.busy === "segment_add"}><Plus className="size-4" />{t("seg.add")}</button>
      </form>
    </div>
  );
}

function SegmentRow({ d, s, first, last, lights, onMove }: { d: LightDevice; s: Segment; first: boolean; last: boolean; lights: LightsApi; onMove: (dir: -1 | 1) => void }) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(s.name);
  const [count, setCount] = React.useState(s.ledCount);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => { setName(s.name); setCount(s.ledCount); }, [s.name, s.ledCount]);
  const upd = (patch: Record<string, unknown>, ok?: string) => lights.op({ op: "segment_update", id: s.id, patch }, ok ? { ok } : undefined).catch(() => undefined);
  const commitName = () => { if (name.trim() && name.trim() !== s.name) void upd({ name: name.trim() }); };
  const commitCount = () => { if (count >= 1 && count !== s.ledCount) void upd({ ledCount: count }); };
  return (
    <li className="rounded-xl border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 text-center text-xs tabular-nums text-muted">{s.ord + 1}</span>
        <input className="input min-w-0 flex-1 py-1.5" aria-label={t("seg.name")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && commitName()} />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input className="input w-20 py-1.5" type="number" min={1} max={5000} aria-label={t("seg.leds")} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} onBlur={commitCount} onKeyDown={(e) => e.key === "Enter" && commitCount()} />LED
        </label>
        <span className="text-xs tabular-nums text-muted" title={t("seg.startHint")}>{t("seg.range", { from: s.ledStart, to: s.ledStart + s.ledCount - 1 })}</span>
        <label className="flex items-center gap-1.5 text-xs text-muted"><Switch checked={s.reverse} label={t("seg.reverse")} onChange={(v) => void upd({ reverse: v })} />{t("seg.reverse")}</label>
        <button type="button" className="btn ghost sm" aria-label={t("seg.test", { name: s.name })} title={t("seg.testTitle")} onClick={() => void lights.op({ op: "test_pattern", deviceId: d.id, segmentId: s.id, step: s.ledCount }, { key: `test:${s.id}` }).catch(() => undefined)}><Zap className="size-3.5" /></button>
        <button type="button" className="btn ghost sm" aria-label={t("common.moveUp")} disabled={first} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></button>
        <button type="button" className="btn ghost sm" aria-label={t("common.moveDown")} disabled={last} onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></button>
        <button type="button" className="btn ghost sm hover:text-down" aria-label={t("seg.delete", { name: s.name })} disabled={first && last}
          onClick={() => void confirmDialog({ title: t("seg.deleteConfirm", { name: s.name }), confirm: t("common.delete"), danger: true }).then((ok) => ok && lights.op({ op: "segment_delete", id: s.id }).catch(() => undefined))}><Trash2 className="size-3.5" /></button>
      </div>
      <button type="button" className="btn ghost sm mt-1" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{t("seg.calibration")}{Object.keys(s.calibration).length ? ` · ${t("seg.custom")}` : ""}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-border px-3 py-2">
          <CalibrationEditor value={s.calibration} onPreview={(cal) => preview(lights, `seg:${s.id}`, cal, d.capabilities.whiteOnly)} onSave={(cal) => void upd({ calibration: cal }, t("dev.calibrationSaved"))} />
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------- LED-count wizard */

type WizState = { seg: number; offset: number; lo: number; hi: number; max: number; probe: number; counts: number[]; sent: boolean; finished: boolean };
const FIRST_HI = 60;

/** Binary search per segment: light the first offset+probe LEDs, ask whether the light reaches the end of the section. */
function LedWizard({ d, segments, lights, onClose }: { d: LightDevice; segments: Segment[]; lights: LightsApi; onClose: () => void }) {
  const { t } = useTranslation();
  const start = (seg: number, offset: number, counts: number[]): WizState => ({ seg, offset, lo: 0, hi: FIRST_HI, max: FIRST_HI, probe: bisectNext({ lo: 0, hi: FIRST_HI }).probe, counts, sent: false, finished: false });
  const [w, setW] = React.useState<WizState>(() => start(0, 0, []));
  const [busy, setBusy] = React.useState(false);
  const cur = segments[w.seg];

  const send = React.useCallback(async (s: WizState) => {
    setBusy(true);
    try {
      await api.lightsOp({ op: "led_count", deviceId: d.id, count: s.offset + s.probe });
      await api.lightsOp({ op: "test_pattern", deviceId: d.id, step: s.probe });
      setW({ ...s, sent: true });
    } catch (e) {
      toast("error", String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }, [d.id]);

  const answer = async (reaches: boolean) => {
    let n = bisectNext({ lo: w.lo, hi: w.hi, answer: reaches });
    let max = w.max;
    // never reached the end even at the top of the range: the section is longer, widen and keep going
    if (n.done && !reaches && n.hi === max && max < 5000) {
      max = Math.min(5000, max * 2);
      n = bisectNext({ lo: n.lo, hi: max });
    }
    if (!n.done) return send({ ...w, lo: n.lo, hi: n.hi, max, probe: n.probe });
    const count = n.hi;
    setBusy(true);
    try {
      if (cur) await api.lightsOp({ op: "segment_update", id: cur.id, patch: { ledCount: count } });
      const counts = [...w.counts, count];
      const offset = w.offset + count;
      if (w.seg + 1 < segments.length) {
        const next = start(w.seg + 1, offset, counts);
        setBusy(false);
        return send(next);
      }
      await api.lightsOp({ op: "led_count", deviceId: d.id, count: offset });
      setW({ ...w, counts, offset, finished: true });
      toast("ok", t("wizard.doneToast", { total: offset }));
      void lights.refresh();
    } catch (e) {
      toast("error", String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const steps = Math.ceil(Math.log2(Math.max(2, w.hi - w.lo)));
  return (
    <Dialog title={t("wizard.title", { name: d.name })} sub={t("wizard.sub")} onClose={onClose} width={560}>
      {w.finished ? (
        <div className="grid gap-3">
          <p className="text-sm">{t("wizard.done", { total: w.offset })}</p>
          <ul className="grid gap-1 text-sm">{segments.map((s, i) => <li key={s.id} className="flex justify-between"><span>{s.name}</span><span className="tabular-nums text-muted">{w.counts[i] ?? s.ledCount} LED</span></li>)}</ul>
          <div className="flex justify-end"><button type="button" className="btn primary" onClick={onClose}>{t("common.close")}</button></div>
        </div>
      ) : (
        <div className="grid gap-4">
          <ol className="flex flex-wrap gap-1.5" aria-label={t("dev.segments")}>
            {segments.map((s, i) => <li key={s.id} className={cn("rounded-full border px-2.5 py-0.5 text-xs", i === w.seg ? "border-primary text-fg" : i < w.seg ? "border-ok/50 text-ok" : "border-border text-muted")}>{s.name}{w.counts[i] ? ` · ${w.counts[i]}` : ""}</li>)}
          </ol>
          <p className="text-sm text-muted">{t("wizard.explain", { n: w.probe, name: cur?.name ?? "" })}</p>
          <div className="rounded-xl border border-border px-3 py-2.5 text-sm tabular-nums">
            <div>{t("wizard.probe", { n: w.probe, total: w.offset + w.probe })}</div>
            <div className="text-xs text-muted">{t("wizard.range", { lo: w.lo + 1, hi: w.hi, steps })}</div>
          </div>
          {!w.sent ? (
            <div className="flex justify-end gap-2">
              <button type="button" className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void send(w)}><Zap className="size-4" />{t("wizard.start")}</button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2" aria-live="polite">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => void send(w)}>{t("wizard.again")}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>{t("wizard.short")}</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void answer(true)}>{t("wizard.reaches")}</button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ BLE scan */

function ScanDialog({ payload, lights, onClose, onAdded }: { payload: LightsPayload; lights: LightsApi; onClose: () => void; onAdded: (id: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState<Discovered[] | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const known = new Set(payload.devices.map((d) => normMac(d.address)));
  const fallback = React.useRef(payload.discovered ?? []);
  fallback.current = payload.discovered ?? [];
  const run = React.useCallback(async () => {
    setScanning(true);
    setErr(null);
    try {
      setItems(await api.bleScan(8));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      setItems(fallback.current);
    } finally {
      setScanning(false);
    }
  }, []);
  React.useEffect(() => void run(), [run]);
  const fresh = (items ?? []).filter((i) => !known.has(normMac(i.mac)));

  const add = (i: Discovered) => {
    const id = slugFor(i.name || "ble", i.mac);
    const device = {
      id, name: i.name || i.mac, room: "bedroom", transport: "ble", address: i.mac.toUpperCase(), protocol: i.protocol ?? "melk",
      capabilities: { onoff: true, brightness: true, rgb: true, kelvin: null, effects: [], addressable: false, segments: true, ledCountConfig: true, whiteOnly: false },
      fingerprint: i.mac.toUpperCase(), discoveredVia: "ble_scan",
    };
    void lights.op({ op: "device_add", device }, { key: `add:${i.mac}`, ok: t("scan.added", { name: device.name }) }).then(() => { onAdded(id); onClose(); }).catch(() => undefined);
  };

  return (
    <Dialog title={t("scan.title")} sub={t("scan.sub")} onClose={onClose}>
      {scanning ? (
        <div className="flex items-center justify-center gap-3 py-8 text-sm text-muted" role="status"><Radar className="size-5 motion-safe:animate-pulse text-primary-text" aria-hidden />{t("scan.scanning")}</div>
      ) : (
        <div className="grid gap-2">
          {err && <p className="text-xs text-warn">{t("scan.failed", { error: err })}</p>}
          {fresh.length === 0 ? <Empty text={t("scan.none")} illustration="search" /> : fresh.map((i) => (
            <div key={i.mac} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{i.name || t("scan.unnamed")}</div>
                <div className="text-xs text-muted tabular-nums">{i.mac}{i.protocol ? ` · ${i.protocol}` : ""}{i.rssi != null ? ` · ${i.rssi} dBm` : ""}</div>
              </div>
              <button type="button" className="btn primary sm" disabled={lights.busy === `add:${i.mac}`} onClick={() => add(i)}><Plus className="size-3.5" />{t("scan.add")}</button>
            </div>
          ))}
          {(items?.length ?? 0) > fresh.length && <p className="text-xs text-muted">{t("scan.known", { count: (items?.length ?? 0) - fresh.length })}</p>}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn ghost" onClick={onClose}>{t("common.close")}</button>
        <button type="button" className="btn" disabled={scanning} onClick={() => void run()}><Radar className="size-4" />{t("scan.again")}</button>
      </div>
    </Dialog>
  );
}
