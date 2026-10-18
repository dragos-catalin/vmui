import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { AMBILIGHT_LABEL, ambilightStatus } from "@/lib/home/ambilight-status";
import { ha, type HaState } from "@/lib/home/ha-client";
import { desc } from "drizzle-orm";
import "server-only";
import { recentActivity } from "./activity";
import { text, textCentered, textRight, textScroll, textWidth, wrap } from "./font";
import { Framebuffer, H, W, YELLOW_ROWS } from "./framebuffer";

// Each view paints a 128x64 frame. The top 16 rows are the yellow band on the
// ideaspark panel, so every view puts its title there and body below.

export type ViewId = "clock" | "weather" | "activity" | "home" | "ambilight" | "system" | "todo" | "notes";

export const VIEW_ORDER: ViewId[] = ["clock", "weather", "activity", "home", "ambilight", "todo", "notes", "system"];

export type ViewContext = {
  states: Map<string, HaState>;
  now: Date;
  node: string;
  paused: boolean;
  ambilightMode: string;
};

function band(fb: Framebuffer, title: string, right?: string, t = 0): void {
  fb.fill(0, 0, W, YELLOW_ROWS, true);
  const rightW = right ? textWidth(right) + 6 : 0;
  textScroll(fb, 2, 4, W - 4 - rightW, title, t, 1, false);
  if (right) textRight(fb, 125, 4, right, 1, false);
}

function hhmm(d: Date): string {
  return d.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bucharest" });
}

const DAYS = ["Duminica", "Luni", "Marti", "Miercuri", "Joi", "Vineri", "Sambata"];
const MONTHS = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "nov", "dec"];

function st(ctx: ViewContext, id: string): HaState | undefined {
  return ctx.states.get(id);
}

// HA is configured metric, but be explicit: convert if an entity reports °F / mph / inHg.
function celsius(v: unknown, unit?: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return unit === "°F" ? (n - 32) / 1.8 : n;
}
function kmh(v: unknown, unit?: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return unit === "mph" ? n * 1.609344 : unit === "m/s" ? n * 3.6 : n;
}
function hpa(v: unknown, unit?: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return unit === "inHg" ? n * 33.8639 : unit === "psi" ? n * 68.9476 : n;
}
function fmtC(n: number | null, digits = 0): string {
  return n === null ? "--" : `${n.toFixed(digits)}*C`;
}

/** One body line: label fixed, value scrolls if it does not fit the remaining width. */
function line(fb: Framebuffer, y: number, label: string, value: string, ctx: ViewContext): void {
  const lx = text(fb, 0, y, label) + 4;
  textScroll(fb, lx, y, W - lx, value, ctx.now.getTime());
}
function num(s: HaState | undefined, digits = 0): string {
  if (!s || s.state === "unavailable" || s.state === "unknown") return "--";
  const n = Number(s.state);
  return Number.isFinite(n) ? n.toFixed(digits) : s.state;
}

// ---------------------------------------------------------------- views

function viewClock(fb: Framebuffer, ctx: ViewContext): void {
  const d = ctx.now;
  const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Bucharest" }));
  band(fb, DAYS[local.getDay()]!, `${local.getDate()} ${MONTHS[local.getMonth()]}`);
  textCentered(fb, 22, hhmm(d), 3);
  const temp = st(ctx, "sensor.temperature_and_humidity_sensor_temperature");
  const hum = st(ctx, "sensor.temperature_and_humidity_sensor_humidity");
  const w = st(ctx, "weather.forecast_home");
  const out = w ? fmtC(celsius(w.attributes.temperature, w.attributes.temperature_unit)) : "--";
  const inside = fmtC(celsius(temp?.state, temp?.attributes.unit_of_measurement), 1);
  text(fb, 0, 54, `in ${inside} ${num(hum)}%`);
  textRight(fb, 127, 54, `afara ${out}`);
}

const WEATHER_RO: Record<string, string> = {
  "clear-night": "senin", sunny: "soare", cloudy: "innorat", partlycloudy: "partial nori", fog: "ceata", hail: "grindina",
  lightning: "furtuna", "lightning-rainy": "furtuna", pouring: "ploaie torentiala", rainy: "ploaie", snowy: "ninsoare",
  "snowy-rainy": "lapovita", windy: "vant", "windy-variant": "vant", exceptional: "extrem",
};

function viewWeather(fb: Framebuffer, ctx: ViewContext): void {
  const w = st(ctx, "weather.forecast_home");
  band(fb, "Vremea", "Home");
  if (!w) return void textCentered(fb, 34, "fara date meteo");
  const a = w.attributes as Record<string, number | string>;
  const tC = celsius(a.temperature, a.temperature_unit);
  const big = tC === null ? "--" : `${Math.round(tC)}`;
  const bx = text(fb, 2, 20, big, 3);
  text(fb, bx + 2, 20, "*C");
  textScroll(fb, 62, 20, 66, WEATHER_RO[w.state] ?? w.state, ctx.now.getTime());
  text(fb, 62, 30, `umid ${a.humidity ?? "--"}%`);
  const wind = kmh(a.wind_speed ?? 0, a.wind_speed_unit);
  text(fb, 62, 40, `vant ${wind === null ? "--" : Math.round(wind)} km/h`);
  const p = hpa(a.pressure ?? 0, a.pressure_unit);
  text(fb, 2, 54, `${p === null ? "--" : Math.round(p)} hPa`);
  const sun = st(ctx, "sun.sun");
  if (sun) {
    const next = sun.state === "above_horizon" ? sun.attributes.next_setting : sun.attributes.next_rising;
    if (typeof next === "string") textRight(fb, 125, 54, `${sun.state === "above_horizon" ? "apus" : "rasarit"} ${hhmm(new Date(next))}`);
  }
}

function viewActivity(fb: Framebuffer, ctx: ViewContext): void {
  const items = recentActivity(6);
  band(fb, "Activitate", `${items.length}`);
  if (!items.length) return void textCentered(fb, 34, "nimic recent");
  let y = 18;
  for (const it of items.slice(0, 5)) {
    const t = hhmm(new Date(it.at));
    text(fb, 0, y, t);
    textScroll(fb, 34, y, W - 34, it.text, ctx.now.getTime());
    y += 9;
  }
}

function viewHome(fb: Framebuffer, ctx: ViewContext): void {
  const lightsOn = [...ctx.states.values()].filter((s) => s.entity_id.startsWith("light.") && s.state === "on").length;
  band(fb, "Acasa", `${lightsOn} lumini`);
  const door = st(ctx, "binary_sensor.main_door_door");
  const ac = st(ctx, "climate.bedroom_ac");
  const ac2 = st(ctx, "climate.living_room_ac_mami");
  const person = st(ctx, "person.dragos");
  const acText = (c: HaState | undefined) => (c ? (c.state === "off" ? "oprit" : `${c.state} ${fmtC(celsius(c.attributes.temperature, c.attributes.temperature_unit))} (acum ${fmtC(celsius(c.attributes.current_temperature, c.attributes.temperature_unit))})`) : "--");
  line(fb, 18, "usa:", door ? (door.state === "on" ? "DESCHISA" : "inchisa") : "--", ctx);
  line(fb, 27, "AC dorm:", acText(ac), ctx);
  line(fb, 36, "AC living:", acText(ac2), ctx);
  line(fb, 45, "Dragos:", person ? (person.state === "home" ? "acasa" : person.state === "not_home" ? "plecat" : person.state) : "--", ctx);
}

function viewAmbilight(fb: Framebuffer, ctx: ViewContext): void {
  band(fb, "Ambilight", ctx.ambilightMode);
  const bar = st(ctx, "light.desk_light_bar");
  const strip = st(ctx, "light.led_argb");
  const hyper = st(ctx, "light.hyperhdr");
  line(fb, 18, "HyperHDR:", AMBILIGHT_LABEL[ambilightStatus(hyper)], ctx);
  line(fb, 27, "bara birou:", bar ? (bar.state === "on" ? `${Math.round(Number(bar.attributes.brightness ?? 0) / 2.55)}%` : "stinsa") : "--", ctx);
  line(fb, 36, "banda MELK:", strip ? (strip.state === "on" ? "on" : strip.state) : "--", ctx);
  if (strip?.state === "on" && Array.isArray(strip.attributes.rgb_color)) {
    const [r, g, b] = strip.attributes.rgb_color as number[];
    line(fb, 45, "culoare", `${r},${g},${b}`, ctx);
  }
  textScroll(fb, 0, 54, W, "BOOT: scurt=urmator  dublu=pauza  lung=movie on/off", ctx.now.getTime());
}

async function viewTodo(fb: Framebuffer, ctx: ViewContext): Promise<void> {
  band(fb, "Cumparaturi");
  try {
    const r = (await ha.callService("todo", "get_items", { entity_id: "todo.shopping_list", status: "needs_action" })) as unknown as Record<string, { items?: Array<{ summary: string }> }>;
    const items = r["todo.shopping_list"]?.items ?? [];
    if (!items.length) return void textCentered(fb, 34, "lista goala");
    let y = 18;
    const more = items.length > 5 ? `+${items.length - 5}` : "";
    for (const [i, it] of items.slice(0, 5).entries()) {
      text(fb, 0, y, "-");
      const reserve = i === 4 && more ? textWidth(more) + 4 : 0;
      textScroll(fb, 8, y, W - 8 - reserve, it.summary, ctx.now.getTime());
      y += 9;
    }
    if (more) textRight(fb, 125, 54, more);
  } catch {
    textCentered(fb, 34, "todo indisponibil");
  }
}

async function viewNotes(fb: Framebuffer, ctx: ViewContext): Promise<void> {
  // Notes = the last things the operator did in vmui (audit log), which
  // doubles as a "what did I change" reminder on the desk.
  band(fb, "Ultimele actiuni", "vmui");
  const rows = await db.select({ action: auditLog.action, target: auditLog.target, createdAt: auditLog.createdAt }).from(auditLog).orderBy(desc(auditLog.createdAt)).limit(5);
  if (!rows.length) return void textCentered(fb, 34, "nimic");
  let y = 18;
  for (const r of rows) {
    const t = r.createdAt ? hhmm(new Date(r.createdAt)) : "";
    text(fb, 0, y, t);
    textScroll(fb, 34, y, W - 34, `${r.action.replace(/^home\./, "")} ${(r.target ?? "").split(".").pop() ?? ""}`, ctx.now.getTime());
    y += 9;
  }
}

function viewSystem(fb: Framebuffer, ctx: ViewContext): void {
  band(fb, "Sistem", ctx.node);
  const upd = [...ctx.states.values()].filter((s) => s.entity_id.startsWith("update.") && s.state === "on").length;
  const unavailable = [...ctx.states.values()].filter((s) => s.state === "unavailable").length;
  const rssi = st(ctx, `sensor.${ctx.node.replace(/-/g, "_")}_wifi_signal`);
  const bat = st(ctx, "sensor.dragos_s_s25_ultra_battery_level");
  line(fb, 18, "HA:", `${ctx.states.size} entitati, ${unavailable} indisponibile`, ctx);
  line(fb, 27, "update-uri:", `${upd}`, ctx);
  line(fb, 36, "wifi esp:", rssi ? `${rssi.state} dBm` : "--", ctx);
  line(fb, 45, "telefon:", bat ? `${bat.state}%` : "--", ctx);
  text(fb, 0, 54, "mui.dragoscatalin.ro");
}

export async function renderView(id: ViewId, ctx: ViewContext): Promise<Framebuffer> {
  const fb = new Framebuffer();
  switch (id) {
    case "clock": viewClock(fb, ctx); break;
    case "weather": viewWeather(fb, ctx); break;
    case "activity": viewActivity(fb, ctx); break;
    case "home": viewHome(fb, ctx); break;
    case "ambilight": viewAmbilight(fb, ctx); break;
    case "todo": await viewTodo(fb, ctx); break;
    case "notes": await viewNotes(fb, ctx); break;
    case "system": viewSystem(fb, ctx); break;
  }
  if (ctx.paused) {
    // Tiny pause glyph in the band's right corner (over the title bar).
    fb.fill(118, 3, 3, 9, false);
    fb.fill(123, 3, 3, 9, false);
  }
  // Gallery position dots along the bottom edge.
  const i = VIEW_ORDER.indexOf(id);
  const n = VIEW_ORDER.length;
  const x0 = Math.floor((W - (n * 4 - 2)) / 2);
  for (let k = 0; k < n; k++) fb.fill(x0 + k * 4, H - 1, k === i ? 2 : 1, 1, true);
  return fb;
}

/** Wrap a free-text message into a frame (used by pushed notifications). */
export function renderMessage(title: string, body: string): Framebuffer {
  const fb = new Framebuffer();
  band(fb, title);
  let y = 20;
  for (const line of wrap(body, 126, 4)) {
    text(fb, 1, y, line);
    y += 10;
  }
  return fb;
}

export type WaterCard = {
  action: "add" | "undo" | "noop";
  ml: number;
  targetMl: number;
  glasses: number;
  /** Today's glasses, newest first, ms epoch. */
  entries: Array<{ at: number; ml: number }>;
  /** Last 7 days incl. today, oldest first. */
  week: Array<{ day: string; ml: number }>;
  lastAt: number | null;
};

const fmtL = (ml: number) => (ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/\.?0+$/, "")}L` : `${ml}ml`);

/** Water card for the desk button: what just happened, the day total against
 *  the target, the glasses so far and the week. Fits the 128x64 two-colour
 *  panel: yellow band = headline, blue body = numbers. */
export function renderWater(w: WaterCard): Framebuffer {
  const fb = new Framebuffer();
  const head = w.action === "add" ? `+${w.entries[0]?.ml ?? 250} ml apa` : w.action === "undo" ? "Pahar anulat" : "Nimic de anulat";
  band(fb, head, w.lastAt ? hhmm(new Date(w.lastAt)) : undefined);

  // total (size 2) / target; the remaining amount goes right of the glasses row
  // so a long total like "1.25L" never collides with it
  const total = fmtL(w.ml);
  text(fb, 1, 19, total, 2);
  const tx = 1 + textWidth(total, 2) + 3;
  text(fb, tx, 26, `/ ${fmtL(w.targetMl)}`);
  const rem = w.targetMl - w.ml;

  // progress bar with a tick per glass position
  const bx = 1, by = 37, bw = 126, bh = 6;
  fb.rect(bx, by, bw, bh);
  const frac = Math.min(1, w.targetMl > 0 ? w.ml / w.targetMl : 0);
  if (frac > 0) fb.fill(bx + 1, by + 1, Math.max(1, Math.round((bw - 2) * frac)), bh - 2);
  const glassPx = w.targetMl > 0 ? ((bw - 2) * 250) / w.targetMl : 0;
  for (let x = bx + 1 + glassPx; x < bx + bw - 1 && glassPx >= 4; x += glassPx) fb.set(Math.round(x), by + bh, true);

  // today's glasses as filled circles (max 12), newest blinking
  const n = Math.min(12, w.glasses);
  for (let i = 0; i < n; i++) {
    const x = 1 + i * 10;
    const y = 47;
    const newest = i === n - 1 && w.action === "add" && Math.floor(Date.now() / 400) % 2 === 0;
    if (newest) fb.rect(x, y, 7, 7);
    else fb.fill(x, y, 7, 7);
  }
  if (w.glasses > 12) text(fb, 1 + 12 * 10, 47, `+${w.glasses - 12}`);
  if (n <= 8) textRight(fb, 127, 47, rem > 0 ? `inca ${fmtL(rem)}` : "tinta OK");

  // 7-day strip along the bottom: bar height 1..7 vs target
  const sy = 63;
  const mx = Math.max(w.targetMl, ...w.week.map((d) => d.ml));
  w.week.slice(-7).forEach((d, i) => {
    const x = 1 + i * 18;
    const h = mx > 0 ? Math.round((7 * d.ml) / mx) : 0;
    if (h > 0) fb.fill(x, sy - h, 14, h);
    else fb.hline(x, x + 13, sy);
  });
  // target line across the strip
  const ty = sy - Math.round((7 * w.targetMl) / mx);
  for (let x = 1; x < 127; x += 3) fb.set(x, ty, true);
  return fb;
}
