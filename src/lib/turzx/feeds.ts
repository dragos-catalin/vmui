import { db } from "@/lib/db";
import { instances } from "@/lib/db/schema";
import { ha } from "@/lib/home/ha-client";
import { screenText } from "@/lib/home/device-text";
import "server-only";
import type { TurzxBgSource } from "./catalog";

// External data for the desk screen. Every fetch is keyless, cached in
// memory with a TTL and degrades to null — the renderer must never wait on
// a third party. All sources are the ones dashy (E:\gh\dashy) already
// vetted for licence: APOD, Met (CC0), Art Institute (public domain),
// Wikimedia Commons POTD, BNR, CoinGecko.

const cache = new Map<string, { at: number; ttl: number; value: unknown; inflight?: Promise<unknown> }>();

/** Never blocks the poll: a cold miss waits at most `waitMs` (default 1.5 s),
 *  then returns null while the fetch finishes in the background. */
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, waitMs = 1500): Promise<T | null> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < hit.ttl) return hit.value as T;
  if (hit?.inflight) return (hit.value as T) ?? null;
  const inflight = fn()
    .then((v) => {
      cache.set(key, { at: Date.now(), ttl: ttlMs, value: v });
      return v;
    })
    .catch(() => {
      // keep stale value if any, retry after a shorter backoff
      cache.set(key, { at: Date.now(), ttl: Math.min(ttlMs, 5 * 60_000), value: hit?.value ?? null });
      return (hit?.value as T) ?? null;
    });
  cache.set(key, { at: hit?.at ?? 0, ttl: hit?.ttl ?? 0, value: hit?.value ?? null, inflight });
  if (!hit) return Promise.race([inflight, new Promise<null>((res) => setTimeout(() => res(null), waitMs))]);
  return hit.value as T; // stale-while-revalidate
}

const UA = { "User-Agent": "vmui-turzx/1.0 (desk display; https://github.com/dragoscv/vmui)" };
const get = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
};

// ---------------------------------------------------------------- BNR
export interface FxRate {
  code: string;
  rate: number;
  prev: number | null;
  history: number[]; // oldest → newest, up to 30 daily closes
}

export async function bnrRates(codes: string[]): Promise<{ date: string; rates: FxRate[] } | null> {
  return cached(`bnr:${codes.join(",")}`, 60 * 60_000, async () => {
    // www.bnr.ro answers this path with the HTML homepage; curs.bnr.ro serves the XML.
    const r = await fetch("https://curs.bnr.ro/nbrfxrates10days.xml", { headers: UA, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) throw new Error(`bnr ${r.status}`);
    const xml = await r.text();
    // One <Cube date="..."> per day, each with <Rate currency="EUR" [multiplier="100"]>4.97</Rate>
    const days = [...xml.matchAll(/<Cube date="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/Cube>/g)].map((m) => {
      const date = m[1] ?? "";
      const rates = new Map<string, number>();
      for (const rm of (m[2] ?? "").matchAll(/<Rate currency="([A-Z]{3})"(?: multiplier="(\d+)")?>([\d.]+)<\/Rate>/g)) {
        rates.set(rm[1] ?? "", Number(rm[3]) / Number(rm[2] ?? 1));
      }
      return { date, rates };
    });
    days.sort((a, b) => a.date.localeCompare(b.date));
    const last = days.at(-1);
    if (!last) throw new Error("bnr: no cubes");
    return {
      date: last.date,
      rates: codes.map((code) => ({
        code,
        rate: last.rates.get(code) ?? 0,
        prev: days.at(-2)?.rates.get(code) ?? null,
        history: days.map((d) => d.rates.get(code) ?? 0).filter(Boolean),
      })),
    };
  });
}

// ---------------------------------------------------------------- CoinGecko
export interface CoinPrice {
  id: string;
  symbol: string;
  price: number;
  change24h: number;
  sparkline: number[];
}

export async function coinPrices(ids: string[], vs: string): Promise<CoinPrice[] | null> {
  if (!ids.length) return [];
  return cached(`cg:${vs}:${ids.join(",")}`, 3 * 60_000, async () => {
    const rows = await get<Array<{ id: string; symbol: string; current_price: number; price_change_percentage_24h: number; sparkline_in_7d?: { price: number[] } }>>(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${vs}&ids=${ids.join(",")}&sparkline=true&price_change_percentage=24h`,
    );
    return rows.map((r) => {
      const sp = r.sparkline_in_7d?.price ?? [];
      return { id: r.id, symbol: r.symbol.toUpperCase(), price: r.current_price, change24h: r.price_change_percentage_24h ?? 0, sparkline: sp.slice(-24) };
    });
  });
}

// ---------------------------------------------------------------- photos
export interface Photo {
  url: string;
  title: string;
  credit: string;
  source: TurzxBgSource;
}

async function apod(): Promise<Photo[]> {
  const rows = await get<Array<{ media_type: string; url: string; hdurl?: string; title: string; copyright?: string }>>(
    "https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&count=8&thumbs=true",
  );
  return rows.filter((r) => r.media_type === "image").map((r) => ({ url: r.url, title: r.title, credit: (r.copyright ?? "NASA").trim() + " · NASA APOD", source: "apod" as const }));
}

async function met(): Promise<Photo[]> {
  const search = await get<{ objectIDs: number[] | null }>("https://collectionapi.metmuseum.org/public/collection/v1/search?isHighlight=true&hasImages=true&isPublicDomain=true&q=painting");
  const ids = (search.objectIDs ?? []).sort(() => Math.random() - 0.5).slice(0, 8);
  const out: Photo[] = [];
  for (const id of ids) {
    try {
      const o = await get<{ primaryImageSmall: string; title: string; artistDisplayName: string; isPublicDomain: boolean }>(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
      if (o.isPublicDomain && o.primaryImageSmall) out.push({ url: o.primaryImageSmall, title: o.title, credit: (o.artistDisplayName || "Unknown") + " · The Met, CC0", source: "met" });
    } catch {
      // skip object
    }
  }
  return out;
}

async function artic(): Promise<Photo[]> {
  const page = 1 + Math.floor(Math.random() * 20);
  const r = await get<{ data: Array<{ image_id: string | null; title: string; artist_title: string | null; is_public_domain: boolean }>; config: { iiif_url: string } }>(
    `https://api.artic.edu/api/v1/artworks/search?query[term][is_public_domain]=true&fields=image_id,title,artist_title,is_public_domain&limit=12&page=${page}`,
  );
  return r.data
    .filter((a) => a.image_id && a.is_public_domain)
    .map((a) => ({ url: `${r.config.iiif_url}/${a.image_id}/full/843,/0/default.jpg`, title: a.title, credit: (a.artist_title ?? "Unknown") + " · Art Institute of Chicago", source: "artic" as const }));
}

async function commons(): Promise<Photo[]> {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10);
  const r = await get<{ query: { pages: Record<string, { images?: Array<{ title: string }> }> } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=images&titles=Template:Potd/${ymd}&origin=*`,
  );
  const file = Object.values(r.query.pages)[0]?.images?.find((i) => /\.(jpe?g|png)$/i.test(i.title))?.title;
  if (!file) return [];
  const info = await get<{ query: { pages: Record<string, { imageinfo?: Array<{ thumburl: string; extmetadata?: { Artist?: { value: string }; ObjectName?: { value: string } } }> }> } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1024&titles=${encodeURIComponent(file)}&origin=*`,
  );
  const ii = Object.values(info.query.pages)[0]?.imageinfo?.[0];
  if (!ii) return [];
  const strip = (s?: string) => (s ?? "").replace(/<[^>]+>/g, "").trim();
  return [{ url: ii.thumburl, title: strip(ii.extmetadata?.ObjectName?.value) || file.replace(/^File:/, ""), credit: (strip(ii.extmetadata?.Artist?.value) || "Wikimedia Commons") + " · Commons POTD", source: "commons" }];
}

const PHOTO_FETCHERS: Record<Exclude<TurzxBgSource, "folder">, () => Promise<Photo[]>> = { apod, met, artic, commons };

/** Pool of candidate photos from the enabled online sources; refreshed every 6 h. */
export async function photoPool(sources: TurzxBgSource[]): Promise<Photo[]> {
  const online = sources.filter((s): s is Exclude<TurzxBgSource, "folder"> => s !== "folder");
  const lists = await Promise.all(online.map((s) => cached(`photos:${s}`, 6 * 60 * 60_000, PHOTO_FETCHERS[s])));
  return lists.flatMap((l) => l ?? []);
}

// ---------------------------------------------------------------- quotes
export interface Quote {
  text: string;
  author: string;
}

const QUOTES_RO: Quote[] = [
  { text: "Nu tot ce strălucește este aur.", author: "proverb" },
  { text: "Omul sfințește locul.", author: "proverb românesc" },
  { text: "Ce ție nu-ți place, altuia nu-i face.", author: "proverb" },
  { text: "Cine se scoală de dimineață departe ajunge.", author: "proverb" },
  { text: "Graba strică treaba.", author: "proverb" },
  { text: "Apa trece, pietrele rămân.", author: "proverb" },
  { text: "Lucrul bine început e pe jumătate făcut.", author: "Aristotel" },
  { text: "Singura constantă este schimbarea.", author: "Heraclit" },
  { text: "Simplitatea este sofisticarea supremă.", author: "Leonardo da Vinci" },
  { text: "Nu ai timp: îl faci.", author: "anonim" },
  { text: "Fă azi ce alții amână pe mâine.", author: "anonim" },
  { text: "Perfecțiunea se atinge nu când nu mai e nimic de adăugat, ci când nu mai e nimic de scos.", author: "Antoine de Saint-Exupéry" },
];

export async function quoteOfTheDay(lang: "ro" | "en"): Promise<Quote | null> {
  const day = Math.floor(Date.now() / 86_400_000);
  if (lang === "ro") return QUOTES_RO[day % QUOTES_RO.length] ?? null;
  return cached(`quote:en:${day}`, 24 * 60 * 60_000, async () => {
    const r = await get<Array<{ q: string; a: string }>>("https://zenquotes.io/api/today");
    const q = r[0];
    return q ? { text: q.q, author: q.a } : { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" };
  });
}

// ---------------------------------------------------------------- HA history / calendar
export interface ClimatePoint {
  t: number;
  v: number;
}

export async function haHistory(entityId: string, hours = 24): Promise<ClimatePoint[] | null> {
  return cached(`hist:${entityId}:${hours}`, 10 * 60_000, async () => {
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = (await ha.history(entityId, since))[0] ?? [];
    const pts = rows
      .map((r) => {
        const raw = r as unknown as { state?: string; s?: string; last_changed?: string; lu?: number; last_updated?: string };
        const v = Number(raw.state ?? raw.s);
        const t = raw.lu ? raw.lu * 1000 : new Date(raw.last_changed ?? raw.last_updated ?? 0).getTime();
        return { t, v };
      })
      .filter((p) => Number.isFinite(p.v) && p.t > 0);
    // downsample to ≤ 96 points (every 15 min) so the payload stays small
    const step = Math.max(1, Math.ceil(pts.length / 96));
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  });
}

export interface CalEvent {
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string | null;
  calendar: string;
}

export interface ForecastDay {
  t: number;
  cond: string | null;
  hi: number | null;
  lo: number | null;
  rain: number | null; // probability %, when the provider gives it
}

/** Next days from HA's weather entity. 30 min TTL: forecasts change slowly and
 *  the service call is the most expensive thing this route asks HA for. */
export async function weatherForecast(entityId: string, days = 5): Promise<ForecastDay[] | null> {
  return cached(`fc:${entityId}`, 30 * 60_000, async () => {
    const rows = await ha.forecast(entityId, "daily");
    return rows.slice(0, days).map((f) => ({
      t: new Date(f.datetime).getTime(),
      cond: f.condition ?? null,
      hi: typeof f.temperature === "number" ? f.temperature : null,
      lo: typeof f.templow === "number" ? f.templow : null,
      rain: typeof f.precipitation_probability === "number" ? f.precipitation_probability : null,
    }));
  });
}

export async function calendarEvents(entityIds: string[]): Promise<CalEvent[] | null> {
  if (!entityIds.length) return [];
  return cached(`cal:${entityIds.join(",")}`, 5 * 60_000, async () => {
    const start = new Date();
    const end = new Date(Date.now() + 7 * 86_400_000);
    const all = await Promise.all(
      entityIds.map(async (id) => {
        try {
          const evs = await ha.calendarEvents(id, start, end);
          return evs.map((e) => ({
            summary: e.summary,
            start: new Date(e.start.dateTime ?? e.start.date ?? 0).getTime(),
            end: new Date(e.end.dateTime ?? e.end.date ?? 0).getTime(),
            allDay: !e.start.dateTime,
            location: e.location ?? null,
            calendar: id.replace(/^calendar\./, ""),
          }));
        } catch {
          return [];
        }
      }),
    );
    return all.flat().sort((a, b) => a.start - b.start).slice(0, 8);
  });
}

// ---------------------------------------------------------------- vmui fleet
export async function fleet() {
  const rows = await db.select({ id: instances.id, name: instances.name, displayName: instances.displayName, provider: instances.provider, state: instances.state, platform: instances.platform, type: instances.instanceType, pinned: instances.pinned }).from(instances);
  return rows
    .map((r) => ({ id: r.id, name: r.displayName ?? r.name ?? r.id, provider: r.provider, state: r.state, platform: r.platform, type: r.type, pinned: r.pinned }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.state === "running" ? -1 : 1) - (b.state === "running" ? -1 : 1) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- Copilot sessions (local VS Code stores)
export interface AgentSession {
  id: string;
  repo: string;
  profile: string;
  updatedAt: number;
  turnsToday: number;
  lastUser: string | null;
}

/** Reads every profile's github.copilot-chat/session-store.db read-only
 *  (copied with its WAL, like ~/.copilot/hooks/who-owns-file.ps1) and lists
 *  the sessions active in the last `activeMin` minutes.
 *  The store is ~110 MB: a synchronous copy on the request path froze the
 *  event loop for 3 s and timed out the panel's poll, so the copy is async
 *  and the result is served stale-while-revalidate (`cached` returns the
 *  previous value instantly and refreshes in the background). */
export async function agentSessions(activeMin: number): Promise<{ active: AgentSession[]; turnsToday: number; sessionsToday: number } | null> {
  return cached(`agents:${activeMin}`, 30_000, async () => {
    const [{ default: Database }, fs, fsp, path, os] = await Promise.all([import("better-sqlite3"), import("node:fs"), import("node:fs/promises"), import("node:path"), import("node:os")]);
    const home = os.homedir();
    const stores: { profile: string; path: string }[] = [];
    const push = (profile: string, p: string) => fs.existsSync(p) && stores.push({ profile, path: p });
    push("default", path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "Code - Insiders/User/globalStorage/github.copilot-chat/session-store.db"));
    const profiles = path.join(home, "VS Code Insiders Profiles");
    if (fs.existsSync(profiles)) for (const d of fs.readdirSync(profiles)) push(d, path.join(profiles, d, "User/globalStorage/github.copilot-chat/session-store.db"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vmui-agents-"));
    const active: AgentSession[] = [];
    let turnsToday = 0;
    let sessionsToday = 0;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    try {
      for (const s of stores) {
        const tmp = path.join(tmpDir, `${s.profile}.db`);
        try {
          await fsp.copyFile(s.path, tmp);
          for (const ext of ["-wal", "-shm"]) if (fs.existsSync(s.path + ext)) await fsp.copyFile(s.path + ext, tmp + ext);
          const db = new Database(tmp, { readonly: true });
          try {
            const rows = db
              .prepare("select id, cwd, updated_at from sessions where datetime(updated_at) > datetime('now', ?) order by updated_at desc")
              .all(`-${activeMin} minutes`) as { id: string; cwd: string | null; updated_at: string }[];
            const turns = db.prepare("select count(*) c from turns where session_id = ? and timestamp >= ?");
            const last = db.prepare("select user_message from turns where session_id = ? order by turn_index desc limit 1");
            for (const r of rows) {
              const t = (turns.get(r.id, dayStart.toISOString()) as { c: number }).c;
              const u = (last.get(r.id) as { user_message: string | null } | undefined)?.user_message ?? null;
              active.push({
                id: r.id,
                repo: r.cwd ? path.basename(r.cwd) : "?",
                profile: s.profile,
                updatedAt: new Date(r.updated_at).getTime(),
                turnsToday: t,
                lastUser: u ? u.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").replace(/\[Terminal [^\]]*\][^\n]*/g, "").replace(/^Terminal output:.*$/m, "").replace(/\s+/g, " ").trim().slice(0, 140) || null : null,
              });
            }
            turnsToday += (db.prepare("select count(*) c from turns where timestamp >= ?").get(dayStart.toISOString()) as { c: number }).c;
            sessionsToday += (db.prepare("select count(*) c from sessions where datetime(updated_at) >= datetime(?)").get(dayStart.toISOString()) as { c: number }).c;
          } finally {
            db.close();
          }
        } catch {
          // a store mid-write or a foreign schema: skip this profile
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    active.sort((a, b) => b.updatedAt - a.updatedAt);
    return { active: active.slice(0, 8), turnsToday, sessionsToday };
  });
}

// ---------------------------------------------------------------- LRCLIB synced lyrics
export interface LyricLine {
  t: number; // seconds
  text: string;
}

export async function syncedLyrics(title: string, artist: string, durationSec: number | null): Promise<LyricLine[] | null> {
  const key = `lrc:${artist}|${title}`.toLowerCase();
  return cached(key, 24 * 60 * 60_000, async () => {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    if (durationSec) q.set("duration", String(Math.round(durationSec)));
    let r: { syncedLyrics?: string | null } | null = null;
    try {
      r = await get(`https://lrclib.net/api/get?${q}`);
    } catch {
      const list = await get<{ syncedLyrics?: string | null }[]>(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
      r = list.find((x) => x.syncedLyrics) ?? null;
    }
    const raw = r?.syncedLyrics;
    if (!raw) return [];
    const lines: LyricLine[] = [];
    for (const m of raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/g)) {
      const text = (m[3] ?? "").trim();
      if (text) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
    }
    return lines;
  });
}

// ---------------------------------------------------------------- HA: hourly forecast, energy, batteries
export interface HourPoint {
  t: number;
  temp: number | null;
  cond: string | null;
  rain: number | null; // precipitation probability %
}

export async function hourlyForecast(entityId: string): Promise<HourPoint[] | null> {
  return cached(`fc-h:${entityId}`, 20 * 60_000, async () => {
    const fc = (await ha.forecast(entityId, "hourly")) as Record<string, unknown>[];
    return fc.slice(0, 12).map((f) => ({
      t: new Date(String(f.datetime)).getTime(),
      temp: typeof f.temperature === "number" ? f.temperature : null,
      cond: typeof f.condition === "string" ? f.condition : null,
      rain: typeof f.precipitation_probability === "number" ? f.precipitation_probability : null,
    }));
  });
}

export interface EnergyReading {
  id: string;
  name: string;
  powerW: number | null;
  kwhToday: number | null;
}

/** Power (W) and daily energy (kWh) from HA, grouped by device. Sensors are
 *  matched by device_class power/energy/current; `mA` current is converted to
 *  W at 230 V because Tuya AC plugs only expose current. */
export function energyReadings(states: Map<string, { entity_id: string; state: string; attributes: Record<string, unknown> }>, only: string[]): EnergyReading[] {
  const byDevice = new Map<string, EnergyReading>();
  const num = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : null);
  for (const s of states.values()) {
    if (!s.entity_id.startsWith("sensor.")) continue;
    if (only.length && !only.includes(s.entity_id)) continue;
    const cls = String(s.attributes.device_class ?? "");
    const unit = String(s.attributes.unit_of_measurement ?? "");
    if (!["power", "energy", "current"].includes(cls)) continue;
    const key = s.entity_id.replace(/^sensor\./, "").replace(/_(power|energy|current|electricity|daily_energy|today_energy|total_energy|voltage)$/, "");
    const name = String(s.attributes.friendly_name ?? key).replace(/\s+(Power|Energy|Current|Electricity|Daily energy|Today energy)$/i, "").trim() || key.replace(/_/g, " ");
    const e = byDevice.get(key) ?? { id: key, name, powerW: null, kwhToday: null };
    const v = num(s.state);
    if (v !== null) {
      if (cls === "power") e.powerW = unit === "kW" ? v * 1000 : v;
      else if (cls === "current") e.powerW = e.powerW ?? (unit === "mA" ? (v / 1000) * 230 : v * 230);
      else if (cls === "energy" && /daily|today/.test(s.entity_id) && (unit === "kWh" || unit === "Wh")) e.kwhToday = unit === "Wh" ? v / 1000 : v;
    }
    byDevice.set(key, e);
  }
  return [...byDevice.values()].filter((e) => e.powerW !== null || e.kwhToday !== null).sort((a, b) => (b.powerW ?? 0) - (a.powerW ?? 0));
}

export interface BatteryReading {
  id: string;
  name: string;
  pct: number;
  charging: boolean | null;
}

export function batteryReadings(states: Map<string, { entity_id: string; state: string; attributes: Record<string, unknown> }>): BatteryReading[] {
  const out: BatteryReading[] = [];
  for (const s of states.values()) {
    if (s.attributes.device_class !== "battery" || !s.entity_id.startsWith("sensor.")) continue;
    const pct = Number(s.state);
    if (!Number.isFinite(pct)) continue;
    const base = s.entity_id.replace(/_battery(_level)?$/, "");
    const st = states.get(`${base}_battery_state`)?.state;
    out.push({ id: s.entity_id, name: String(s.attributes.friendly_name ?? base).replace(/\s+Battery( level)?$/i, ""), pct, charging: st ? st === "charging" : null });
  }
  return out.sort((a, b) => a.pct - b.pct);
}

// ---------------------------------------------------------------- Health (HA companion → Health Connect)
export interface HealthReadings {
  device: string;
  steps: number | null;
  stepsAt: number | null;
  distanceKm: number | null;
  floors: number | null;
  activeKcal: number | null;
  totalKcal: number | null;
  heartRate: number | null;
  heartRateAt: number | null;
  restingHr: number | null;
  hrv: number | null;
  spo2: number | null;
  respiratoryRate: number | null;
  sleepMin: number | null;
  sleepAt: number | null;
  weightKg: number | null;
  weightAt: number | null;
  bodyFat: number | null;
  /** Raw bioimpedance from the scale (Ω); the OKOK pads are often decorative and read a constant. */
  impedance: number | null;
  /** Anthropometric estimates (no impedance): the same class of numbers the OKOK app shows. */
  body: BodyComposition | null;
  bmr: number | null;
  vo2max: number | null;
  bloodPressure: { sys: number; dia: number } | null;
  hrHistory: ClimatePoint[];
}

type HaState = { entity_id: string; state: string; attributes: Record<string, unknown> };

export interface BodyProfile {
  heightCm: number;
  birthDate: string; // YYYY-MM-DD
  sex: "m" | "f";
}

export interface BodyComposition {
  bmi: number;
  /** Deurenberg 1991, % */
  fatPct: number;
  fatKg: number;
  /** Hume & Weyers 1971, kg and % of weight */
  waterKg: number;
  waterPct: number;
  /** Boer 1984, kg */
  leanKg: number;
  /** lean minus a 4 % bone allowance, kg — "muscle" in consumer apps */
  muscleKg: number;
  /** Mifflin–St Jeor, kcal/day */
  bmrKcal: number;
  /** what the app calls bone mass: ~4 % of lean mass */
  boneKg: number;
  ageYears: number;
  /** WHO adult BMI band */
  bmiBand: "sub" | "normal" | "over" | "obese";
}

/** The OKOK/Chipsea scale's "impedance" reads 4990 with socks and 4991
 *  barefoot (2026-09-16), i.e. the pads are decorative; the app's fat / water /
 *  muscle numbers are anthropometric estimates. These are the published
 *  formulas openScale uses, so the panel shows the same class of number and
 *  labels it as an estimate. */
export function bodyComposition(weightKg: number, p: BodyProfile, at = new Date()): BodyComposition {
  const h = p.heightCm;
  const bd = new Date(p.birthDate);
  let age = at.getFullYear() - bd.getFullYear();
  if (at < new Date(at.getFullYear(), bd.getMonth(), bd.getDate())) age -= 1;
  const male = p.sex === "m";
  const bmi = weightKg / (h / 100) ** 2;
  const fatPct = Math.max(3, Math.min(60, 1.2 * bmi + 0.23 * age - (male ? 16.2 : 5.4)));
  const fatKg = (weightKg * fatPct) / 100;
  const waterKg = male ? 0.194786 * h + 0.296785 * weightKg - 14.012934 : 0.34454 * h + 0.183809 * weightKg - 35.270121;
  const leanKg = male ? 0.4071 * weightKg + 0.267 * h - 19.2 : 0.252 * weightKg + 0.473 * h - 48.3;
  const boneKg = leanKg * 0.04;
  const bmr = 10 * weightKg + 6.25 * h - 5 * age + (male ? 5 : -161);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    bmi: r1(bmi),
    fatPct: r1(fatPct),
    fatKg: r1(fatKg),
    waterKg: r1(waterKg),
    waterPct: r1((waterKg / weightKg) * 100),
    leanKg: r1(leanKg),
    muscleKg: r1(leanKg - boneKg),
    bmrKcal: Math.round(bmr),
    boneKg: r1(boneKg),
    ageYears: age,
    bmiBand: bmi < 18.5 ? "sub" : bmi < 25 ? "normal" : bmi < 30 ? "over" : "obese",
  };
}

/** The companion app publishes Health Connect as `sensor.<device>_<metric>`.
 *  Units follow the HA server's unit system (this one is US), so everything is
 *  normalised to metric here and never in the renderer. */
export async function healthReadings(states: Map<string, HaState>, device: string, profile: BodyProfile | null = null): Promise<HealthReadings | null> {
  const prefix = `sensor.${device}_`;
  const get = (m: string) => states.get(prefix + m);
  const num = (m: string): number | null => {
    const v = Number(get(m)?.state);
    return Number.isFinite(v) ? v : null;
  };
  const at = (m: string): number | null => {
    const s = get(m);
    if (!s || !Number.isFinite(Number(s.state))) return null;
    const raw = s as unknown as { last_changed?: string; last_updated?: string };
    const t = new Date(raw.last_changed ?? raw.last_updated ?? 0).getTime();
    return t > 0 ? t : null;
  };
  const unit = (m: string) => String(get(m)?.attributes.unit_of_measurement ?? "");
  const toKm = (m: string) => {
    const v = num(m);
    if (v === null) return null;
    const u = unit(m);
    return u === "ft" ? v * 0.0003048 : u === "mi" ? v * 1.609344 : u === "m" ? v / 1000 : v;
  };
  const toKg = (m: string) => {
    const v = num(m);
    if (v === null) return null;
    const u = unit(m);
    return u === "g" ? v / 1000 : u === "lb" ? v * 0.45359237 : v;
  };
  const toMmHg = (m: string) => {
    const v = num(m);
    if (v === null) return null;
    return unit(m) === "inHg" ? v * 25.4 : v;
  };
  if (!get("steps_sensor") && !get("daily_steps") && !get("heart_rate")) return null;
  // `daily_steps` is Health Connect's day total; `steps_sensor` is the pedometer since reboot.
  const steps = num("daily_steps") ?? num("steps");
  const sys = toMmHg("systolic_blood_pressure");
  const dia = toMmHg("diastolic_blood_pressure");
  const hrHistory = get("heart_rate") ? ((await haHistory(prefix + "heart_rate", 24)) ?? []) : [];
  // The OKOK scale never reaches Health Connect (its app has no HC export), so
  // the ESP32 proxy decodes its BLE adverts into this sensor; prefer HC when
  // it exists (Samsung Health entry), else the scale.
  // The ESPHome sensor resets to `unknown` on every board reboot; fall back
  // to the last numeric point in 14 days of recorder history.
  const scaleEntity = [...states.values()].find((s) => /^sensor\..*scale_weight$/.test(s.entity_id));
  let scaleKg: number | null = scaleEntity && Number.isFinite(Number(scaleEntity.state)) ? Number(scaleEntity.state) : null;
  let scaleAt: number | null = scaleKg !== null && scaleEntity ? new Date((scaleEntity as unknown as { last_changed?: string }).last_changed ?? 0).getTime() || null : null;
  if (scaleKg === null && scaleEntity) {
    // HA history returns [] when `since` predates the first recorded state, so widen stepwise.
    for (const hours of [24, 72, 24 * 7, 24 * 30]) {
      const last = ((await haHistory(scaleEntity.entity_id, hours)) ?? []).filter((p) => p.v > 20).at(-1);
      if (last) {
        scaleKg = last.v;
        scaleAt = last.t;
        break;
      }
    }
  }
  const impedance = [...states.values()].find((s) => /^sensor\..*scale_impedance$/.test(s.entity_id) && Number.isFinite(Number(s.state)));
  const weightKg = toKg("weight") ?? scaleKg;
  return {
    device,
    steps,
    stepsAt: at("daily_steps") ?? at("steps"),
    distanceKm: toKm("daily_distance") ?? toKm("distance"),
    floors: num("daily_floors") ?? num("floors_climbed"),
    activeKcal: num("active_calories_burned"),
    totalKcal: num("total_calories_burned"),
    heartRate: num("heart_rate"),
    heartRateAt: at("heart_rate"),
    restingHr: num("resting_heart_rate"),
    hrv: num("heart_rate_variability"),
    spo2: num("oxygen_saturation"),
    respiratoryRate: num("respiratory_rate"),
    sleepMin: num("sleep_duration"),
    sleepAt: at("sleep_duration"),
    weightKg,
    weightAt: at("weight") ?? scaleAt,
    bodyFat: num("body_fat"),
    impedance: impedance ? Number(impedance.state) : null,
    body: weightKg !== null && profile && profile.heightCm > 0 ? bodyComposition(weightKg, profile) : null,
    bmr: num("basal_metabolic_rate"),
    vo2max: num("vo2_max"),
    bloodPressure: sys !== null && dia !== null ? { sys: Math.round(sys), dia: Math.round(dia) } : null,
    hrHistory,
  };
}

// ---------------------------------------------------------------- Moon phase (local computation, no network)
export function moonPhase(at = new Date()): { phase: number; name: string; illumination: number } {
  // Meeus-style synodic approximation from the 2000-01-06 18:14 UTC new moon.
  const synodic = 29.530588853;
  const days = (at.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000;
  const phase = ((days % synodic) + synodic) % synodic / synodic; // 0 new → 0.5 full → 1 new
  const names = screenText().moon;
  const idx = Math.round(phase * 8) % 8;
  return { phase, name: names[idx] ?? names[0]!, illumination: Math.round((1 - Math.cos(phase * 2 * Math.PI)) * 50) };
}
