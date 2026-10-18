// Light registry types + pure helpers, mirrored from src/lib/lights/model.ts (the Next app).
// Kept local on purpose: the desktop bundle must not import from the server tree.

export type Transport = "ha" | "ble" | "hyperhdr" | "tuya_lan" | "openrgb" | "wled";
export const TRANSPORTS: Transport[] = ["ha", "ble", "hyperhdr", "tuya_lan", "openrgb", "wled"];
export type ColorOrder = "RGB" | "RBG" | "GRB" | "GBR" | "BRG" | "BGR";
export const COLOR_ORDERS: ColorOrder[] = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"];
export type Rgb = [number, number, number];
export type Capabilities = { onoff: true; brightness: boolean; rgb: boolean; kelvin: [number, number] | null; effects: string[]; addressable: boolean; segments: boolean; ledCountConfig: boolean; whiteOnly: boolean };
export type Calibration = { gamma?: number; gains?: Rgb; briCap?: number; briMin?: number; colorOrder?: ColorOrder; kelvinOffset?: number };
export type LightState = { on: boolean; rgb?: Rgb; brightnessPct?: number; kelvin?: number; effect?: string };
export type LightHealth = "ok" | "degraded" | "offline" | "unknown";
export type Segment = { id: string; deviceId: string; ord: number; name: string; ledStart: number; ledCount: number; reverse: boolean; calibration: Calibration };
export type LightDevice = {
  id: string; name: string; room: string; transport: Transport; address: string; protocol: string | null; haEntity?: string | null;
  capabilities: Capabilities; calibration: Calibration; ledCount: number; segments: Segment[]; enabled: boolean; health: LightHealth;
  lastSeenAt: number | null; lastLatencyMs: number | null; lastError: string | null; state: LightState | null;
};
export type LightGroup = { id: string; name: string; kind?: string; members?: string[] };
export type LightScene = { id: string; name: string; entries?: Array<{ target: string; state: LightState }>; createdAt?: number };
export type LightProfile = { id: string; name: string; calibration: Calibration; active: boolean };
export type Discovered = { mac: string; name: string; rssi: number | null; protocol: string | null };
export type LightsPayload = {
  devices: LightDevice[]; groups: LightGroup[]; scenes: LightScene[]; profiles: LightProfile[];
  rooms: Array<string | { id: string; name?: string }>; pcOnline: boolean; discovered?: Discovered[]; haOnline?: boolean;
};
export type BleStatus = { mac: string; connected: boolean; latencyMs: number | null; lastError: string | null };

/** LED-count wizard step (same contract as the server's bisectNext). Invariant lo < N <= hi. */
export function bisectNext(input: { lo: number; hi: number; answer?: boolean }): { lo: number; hi: number; probe: number; done: boolean } {
  let { lo, hi } = input;
  if (hi - lo > 1 && input.answer !== undefined) {
    const probe = Math.ceil((lo + hi) / 2);
    if (input.answer) hi = probe;
    else lo = probe;
  }
  const done = hi - lo <= 1;
  return { lo, hi, probe: done ? hi : Math.ceil((lo + hi) / 2), done };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Approximate sRGB of a black-body white, for previews only (Tanner Helland fit). */
export function kelvinToRgb(k: number): Rgb {
  const t = clamp(k, 1000, 40000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)];
}

/** CSS colour a device currently shows (null when off / unknown). Inline style only — it IS a light colour. */
export function stateColor(s: LightState | null): string | null {
  if (!s?.on) return null;
  const rgb = s.rgb ?? (s.kelvin ? kelvinToRgb(s.kelvin) : ([255, 214, 170] as Rgb));
  const a = s.brightnessPct != null ? 0.25 + 0.75 * (s.brightnessPct / 100) : 1;
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${a.toFixed(2)})`;
}

/** Recompute ledStart = prefix sum, ordered by ord. */
export function withSegmentStarts(segments: readonly Segment[]): Segment[] {
  let start = 0;
  return [...segments].sort((a, b) => a.ord - b.ord).map((s) => {
    const seg = { ...s, ledStart: start };
    start += s.ledCount;
    return seg;
  });
}

export const roomId = (r: LightsPayload["rooms"][number]) => (typeof r === "string" ? r : r.id);
export const normMac = (m: string) => m.replace(/[^0-9a-f]/gi, "").toUpperCase();

/** Registry id for a scanned device: slug of the name + last 4 hex of the MAC. */
export function slugFor(name: string, mac: string): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  const tail = normMac(mac).slice(-4).toLowerCase();
  return `${/^[a-z0-9]/.test(base) ? base : "ble"}_${tail}`.slice(0, 64);
}

export const KELVIN_STEPS = [2700, 3000, 4000, 5000, 6500];

// Light colours are DATA (sent to bulbs/strips), not UI tokens, so hex is correct here.
/** The one light-colour palette (light controls, Casa sheet, ambilight solid colour). */
export const SWATCHES = ["#ffb347", "#ff5a5a", "#5ad1ff", "#7cff9a", "#c084fc", "#ff7ad9", "#ffffff"];
export const LIGHT_SWATCHES = SWATCHES;
/** Ambilight idle colours (dim reds/browns for the strip and glow at rest). */
export const IDLE_SWATCHES = ["#000000", "#a00000", "#500000", "#7a3b00", "#3b1f6b", "#0b3d5c", "#1f4d2b"];
/** Wall paint presets for the ambilight wall compensation. */
export const WALL_SWATCHES = ["#439ebf", "#c8b89a", "#e6e1d8", "#9aa3ad", "#b48a6b", "#6b7b8c"];
/** Accent colours for the Nest Hub / Turzx screens. */
export const SCREEN_ACCENTS = ["#7c9cff", "#f2b85a", "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c"];

const SWATCH_KEYS: Record<string, string> = {
  "#ffb347": "amber", "#ff5a5a": "red", "#5ad1ff": "sky", "#7cff9a": "green", "#c084fc": "violet", "#ff7ad9": "pink", "#ffffff": "white",
  "#000000": "off", "#a00000": "deepRed", "#500000": "ember", "#7a3b00": "brown", "#3b1f6b": "plum", "#0b3d5c": "navy", "#1f4d2b": "forest",
  "#439ebf": "teal", "#c8b89a": "sand", "#e6e1d8": "cream", "#9aa3ad": "grey", "#b48a6b": "wood", "#6b7b8c": "slate",
  "#7c9cff": "periwinkle", "#f2b85a": "gold", "#34d399": "mint", "#f472b6": "rose", "#a78bfa": "lavender", "#22d3ee": "cyan", "#fb923c": "orange",
};

/** Accessible colour name for a swatch (falls back to the hex). */
export function swatchName(hex: string): string {
  const k = SWATCH_KEYS[hex.toLowerCase()];
  return k ? swatchLabel(`swatch.${k}`, hex) : hex;
}
let swatchLabel: (key: string, fallback: string) => string = (_k, f) => f;
/** i18n.ts wires the translator in (keeps this module free of the i18n import cycle). */
export function setSwatchTranslator(f: (key: string, fallback: string) => string) {
  swatchLabel = f;
}
