import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Household config replaces the owner literals (person.dragos, *_s25_ultra, Europe/Bucharest).
// A fresh install must work with no owner values at all; an existing install keeps its
// credentials.env values as the seed; DB edits win over the seed.

const creds: Record<string, string> = {};
vi.mock("@/lib/home/credentials", () => ({ credential: (k: string) => creds[k] }));

let H: typeof import("./household");

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-hh-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  delete process.env.TZ;
  H = await import("./household");
});

describe("household()", () => {
  it("fresh install: neutral defaults, no owner entities", () => {
    const h = H.household();
    expect(h.timeZone).toBe("UTC");
    expect(h.ownerPerson).toBe("");
    expect(H.ownerPhoneSensor("battery_level")).toBeNull();
  });

  it("seeds from credentials.env for an existing install", () => {
    creds.VATRA_TIMEZONE = "Europe/Bucharest";
    creds.PHONE_NOTIFY_SERVICE = "mobile_app_pixel_9";
    H.saveHousehold({}); // invalidates the cache, stores the merged seed
    const h = H.household();
    expect(h.timeZone).toBe("Europe/Bucharest");
    expect(h.ownerPhone).toBe("pixel_9");
    expect(H.ownerPhoneSensor("battery_level")).toBe("sensor.pixel_9_battery_level");
  });

  it("DB edits win and are validated", () => {
    H.saveHousehold({ ownerPerson: "person.ana", timeZone: "Europe/Berlin" });
    expect(H.household().ownerPerson).toBe("person.ana");
    expect(H.householdTimeZone()).toBe("Europe/Berlin");
    expect(() => H.saveHousehold({ timeZone: "" })).toThrow();
  });
});
