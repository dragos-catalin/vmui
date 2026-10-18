// Light registry model: pure types + helpers shared by server, desktop UI and tests.
// No server imports here.

export type Transport = "ha" | "ble" | "hyperhdr" | "tuya_lan" | "openrgb" | "wled";
export const TRANSPORTS = ["ha", "ble", "hyperhdr", "tuya_lan", "openrgb", "wled"] as const satisfies readonly Transport[];

export type ColorOrder = "RGB" | "RBG" | "GRB" | "GBR" | "BRG" | "BGR";
export const COLOR_ORDERS = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"] as const satisfies readonly ColorOrder[];

export type Rgb = [number, number, number];

export type Capabilities = {
  onoff: true;
  brightness: boolean;
  rgb: boolean;
  kelvin: [number, number] | null;
  effects: string[];
  addressable: boolean;
  segments: boolean;
  ledCountConfig: boolean;
  whiteOnly: boolean;
};

export type Calibration = {
  gamma?: number;
  gains?: Rgb;
  briCap?: number;
  briMin?: number;
  colorOrder?: ColorOrder;
  kelvinOffset?: number;
};

export type LightState = { on: boolean; rgb?: Rgb; brightnessPct?: number; kelvin?: number; effect?: string };

export type Health = "ok" | "degraded" | "offline" | "unknown";

export type Segment = {
  id: string;
  deviceId: string;
  ord: number;
  name: string;
  ledStart: number;
  ledCount: number;
  reverse: boolean;
  calibration: Calibration;
};

export type LightDevice = {
  id: string;
  name: string;
  room: string;
  transport: Transport;
  address: string;
  protocol: string | null;
  haEntity: string | null;
  capabilities: Capabilities;
  calibration: Calibration;
  ledCount: number;
  segments: Segment[];
  enabled: boolean;
  health: Health;
  lastSeenAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  state: LightState | null;
};

/** "dev:<id>" | "seg:<id>" | "group:<id>" | "room:<room>" | "all" */
export type LightTarget = `dev:${string}` | `seg:${string}` | `group:${string}` | `room:${string}` | "all";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const byte = (v: number) => clamp(Math.round(v), 0, 255);

/**
 * Effective calibration for one device (+ optional segment, + optional active profile).
 * gamma / colorOrder are hardware facts: segment overrides device. Gains multiply,
 * briCap takes the lowest, briMin the highest, kelvinOffset sums.
 */
export function composeCalibration(device: Calibration, segment?: Calibration | null, profile?: Calibration | null): Calibration {
  const layers = [device, segment ?? {}, profile ?? {}];
  const out: Calibration = {};
  const gamma = segment?.gamma ?? device.gamma;
  if (gamma !== undefined) out.gamma = gamma;
  const colorOrder = segment?.colorOrder ?? device.colorOrder;
  if (colorOrder !== undefined) out.colorOrder = colorOrder;
  let gains: Rgb | undefined;
  for (const l of layers) {
    if (!l.gains) continue;
    gains = gains ? [gains[0] * l.gains[0], gains[1] * l.gains[1], gains[2] * l.gains[2]] : [...l.gains];
  }
  if (gains) out.gains = gains;
  const caps = layers.map((l) => l.briCap).filter((v): v is number => v !== undefined);
  if (caps.length) out.briCap = Math.min(...caps);
  const mins = layers.map((l) => l.briMin).filter((v): v is number => v !== undefined);
  if (mins.length) out.briMin = Math.max(...mins);
  const offs = layers.map((l) => l.kelvinOffset).filter((v): v is number => v !== undefined);
  if (offs.length) out.kelvinOffset = offs.reduce((a, b) => a + b, 0);
  return out;
}

/** Logical RGB -> wire RGB: gains, then gamma, then reorder into the strip's colour order, then clamp. */
export function applyCalibration(rgb: Rgb, cal: Calibration): Rgb {
  const g = cal.gains ?? [1, 1, 1];
  const gamma = cal.gamma ?? 1;
  const lin = rgb.map((v, i) => clamp(v * (g[i] ?? 1), 0, 255));
  const corrected = lin.map((v) => (gamma === 1 ? v : Math.pow(v / 255, gamma) * 255));
  const order = cal.colorOrder ?? "RGB";
  const idx = { R: 0, G: 1, B: 2 } as const;
  const wire = [...order].map((c) => corrected[idx[c as keyof typeof idx]] ?? 0);
  return [byte(wire[0] ?? 0), byte(wire[1] ?? 0), byte(wire[2] ?? 0)];
}

/** Clamp a brightness percentage into [briMin*100, briCap*100]. 0 stays 0 (off is off). */
export function applyBrightness(pct: number, cal: Calibration): number {
  if (pct <= 0) return 0;
  const lo = (cal.briMin ?? 0) * 100;
  const hi = (cal.briCap ?? 1) * 100;
  return Math.round(Math.min(hi, Math.max(lo, Math.min(100, pct))));
}

type SegmentLike = Omit<Segment, "ledStart"> & { ledStart?: number };

/** Sort by ord and set ledStart = prefix sum of the previous segments' ledCount. */
export function withSegmentStarts(segments: readonly SegmentLike[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.ord - b.ord);
  let start = 0;
  return sorted.map((s) => {
    const seg: Segment = { ...s, ledStart: start };
    start += s.ledCount;
    return seg;
  });
}

/** Append a segment at the end (ord = max + 1, 0 for the first) and recompute starts. */
export function appendSegment(
  segments: readonly SegmentLike[],
  input: { name: string; ledCount: number; id?: string; deviceId?: string; reverse?: boolean; calibration?: Calibration },
): Segment[] {
  const ord = segments.length ? Math.max(...segments.map((s) => s.ord)) + 1 : 0;
  const deviceId = input.deviceId ?? segments[0]?.deviceId ?? "";
  const seg: SegmentLike = {
    id: input.id ?? `${deviceId}-s${ord}`,
    deviceId,
    ord,
    name: input.name,
    ledCount: input.ledCount,
    reverse: input.reverse ?? false,
    calibration: input.calibration ?? {},
  };
  return withSegmentStarts([...segments, seg]);
}

/** Strip what the device cannot do. whiteOnly never carries rgb (falls back to 3000 K). */
export function downgrade(state: LightState, caps: Capabilities): LightState {
  if (!state.on) return { on: false };
  const out: LightState = { on: true };
  if (state.rgb && caps.rgb && !caps.whiteOnly) out.rgb = state.rgb;
  let kelvin = state.kelvin;
  if (caps.whiteOnly && state.rgb && kelvin === undefined) kelvin = 3000;
  if (kelvin !== undefined) {
    if (caps.kelvin) out.kelvin = clamp(kelvin, caps.kelvin[0], caps.kelvin[1]);
    else if (caps.whiteOnly) out.kelvin = kelvin;
  }
  if (state.brightnessPct !== undefined && caps.brightness) out.brightnessPct = clamp(state.brightnessPct, 0, 100);
  if (state.effect !== undefined && caps.effects.includes(state.effect)) out.effect = state.effect;
  return out;
}

export type BisectAnswer = boolean | "end" | "reaches_end" | "short";

/**
 * LED-count wizard step. Invariant: lo < N <= hi. The probe lights the first `probe` LEDs;
 * the user answers whether they reach the end of the strip (true / "end") or fall short.
 * Without an answer it only returns the first probe. done => N = hi.
 */
export function bisectNext(input: { lo: number; hi: number; answer?: BisectAnswer }): { lo: number; hi: number; probe: number; done: boolean } {
  let { lo, hi } = input;
  if (hi - lo > 1 && input.answer !== undefined) {
    const probe = Math.ceil((lo + hi) / 2);
    const reaches = input.answer === true || input.answer === "end" || input.answer === "reaches_end";
    if (reaches) hi = probe;
    else lo = probe;
  }
  const done = hi - lo <= 1;
  return { lo, hi, probe: done ? hi : Math.ceil((lo + hi) / 2), done };
}
