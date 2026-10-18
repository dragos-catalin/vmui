/**
 * Accent presets for the device screens (Turzx, Nest Hub). The UI shows them
 * as oklch; the devices take `#rrggbb`, so the hex is derived here, at the
 * boundary, instead of living as hand-written palette literals in components.
 */
export const DEVICE_ACCENT_HUES = [
  { id: "ember", l: 0.78, c: 0.14, h: 70 },
  { id: "indigo", l: 0.7, c: 0.13, h: 270 },
  { id: "mint", l: 0.78, c: 0.14, h: 160 },
  { id: "rose", l: 0.72, c: 0.17, h: 350 },
  { id: "amber", l: 0.84, c: 0.15, h: 85 },
  { id: "violet", l: 0.7, c: 0.15, h: 300 },
  { id: "cyan", l: 0.8, c: 0.12, h: 210 },
  { id: "orange", l: 0.74, c: 0.16, h: 50 },
] as const;

export type DeviceAccentId = (typeof DEVICE_ACCENT_HUES)[number]["id"];

export const oklchCss = ({ l, c, h }: { l: number; c: number; h: number }) => `oklch(${l} ${c} ${h})`;

/** OKLCH → sRGB hex (Björn Ottosson's OKLab matrices), clamped to gamut. */
export function oklchToHex({ l, c, h }: { l: number; c: number; h: number }): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  return (
    "#" +
    lin
      .map((x) => Math.round(Math.min(1, Math.max(0, gamma(x))) * 255))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

export const DEVICE_ACCENTS = DEVICE_ACCENT_HUES.map((a) => ({ id: a.id, css: oklchCss(a), hex: oklchToHex(a) }));
