import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packText, render, unpackText } from "./i18n";

// Every `msg("…")` reference emitted by a server source must resolve in both
// notify dictionaries, or a phone would show the raw key.

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : []; });
const flat = (o: Record<string, unknown>, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));

const dict = (locale: string) => new Set(flat(JSON.parse(readFileSync(`messages/notify/${locale}.json`, "utf8")) as Record<string, unknown>));
const SOURCES = ["src/lib/notify", "src/lib/devices", "src/lib/home", "src/lib/nutrition", "src/app/api/hooks"];

describe("notify message refs", () => {
  const en = dict("en");
  const ro = dict("ro");
  const refs = new Set<string>();
  for (const dir of SOURCES) for (const f of walk(dir)) for (const m of readFileSync(f, "utf8").matchAll(/msg\(\s*"([^"$]+)"/g)) refs.add(m[1]!);

  it("finds the converted sources", () => {
    expect(refs.size).toBeGreaterThan(30);
    expect(refs).toContain("cards.intercom.ringTitle");
    expect(refs).toContain("cards.pairing.title");
    expect(refs).toContain("cards.contact.title");
  });

  it("resolve in en and ro", () => {
    const missing = [...refs].filter((k) => !en.has(k) || !ro.has(k));
    expect(missing).toEqual([]);
  });

  it("dynamic key families exist in both locales", () => {
    for (const k of ["not_found", "expired", "code_mismatch"]) expect(en.has(`errors.pairing.${k}`) && ro.has(`errors.pairing.${k}`)).toBe(true);
    for (const k of ["streak_risk", "over_target", "under_target", "protein_low", "celebration", "weekly_review", "no_data"]) expect(en.has(`cards.coach.title.${k}`) && ro.has(`cards.coach.title.${k}`) && en.has(`cards.coach.fallback.${k}`)).toBe(true);
    for (const k of ["copilot", "agents", "intercom", "pairing", "water", "pc", "pi", "door", "window", "presence", "battery", "contact", "system"]) expect(en.has(`kinds.${k}`) && ro.has(`kinds.${k}`)).toBe(true);
  });
});

describe("render", () => {
  it("renders ICU refs per locale and passes literals through", async () => {
    expect(await render({ key: "cards.pairing.title", params: { name: "S25" } }, "en")).toBe("S25 is asking for access");
    expect(await render({ key: "cards.pairing.title", params: { name: "S25" } }, "ro")).toBe("S25 cere acces");
    expect(await render({ key: "cards.pi.unitsTitle", params: { count: 2 } }, "ro")).toBe("Unități căzute pe Pi");
    expect(await render({ key: "cards.door.title", params: { sensor: "mainDoor" } }, "en")).toBe("The front door was opened");
    expect(await render("literal", "ro")).toBe("literal");
  });

  it("round-trips refs through the packed column format", () => {
    const ref = { key: "results.waterAdded", params: { ml: 250 } };
    expect(unpackText(packText(ref))).toEqual(ref);
    expect(unpackText(packText("plain"))).toBe("plain");
  });
});
