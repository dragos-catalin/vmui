import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeActor } from "@/lib/home/access";

const states = vi.fn();
const readings = vi.fn();
const summary = vi.fn();

vi.mock("@/lib/home/access", () => ({ deviceHomeActor: vi.fn(async () => null) }));
vi.mock("@/lib/home/ha-client", () => ({ ha: { states: () => states() } }));
vi.mock("@/lib/turzx/feeds", () => ({ healthReadings: (...a: unknown[]) => readings(...a) }));
vi.mock("@/lib/nutrition/summary", () => ({ nutritionSummary: (...a: unknown[]) => summary(...a) }));
vi.mock("@/lib/turzx/settings", () => ({ loadTurzxSettings: async () => ({ views: [{ id: "health", options: { device: "phone_x" } }] }) }));

const { authorise, meHealth } = await import("./me");

const actor = (role: HomeActor["role"]): HomeActor =>
  ({ userId: "u1", email: "o@x", displayName: "O", role, rooms: {} as HomeActor["rooms"], expiresAt: null, deviceId: "d1" });
const req = (headers: Record<string, string> = {}, url = "http://x/api/v1/me/health") => new Request(url, { headers });
const bearer = { authorization: "Bearer vmd_abc" };

describe("GET /api/v1/me/health authorisation", () => {
  it("refuses a request with no token", async () => {
    expect(await authorise(req(), async () => actor("owner"))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses an operator API key: health is for the owner's devices, not automation", async () => {
    expect(await authorise(req({ authorization: "Bearer vmui_key" }), async () => actor("owner"))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a device token passed in the query string so it never lands in a URL", async () => {
    expect(await authorise(req({}, "http://x/api/v1/me/health?d=vmd_abc"), async () => actor("owner"))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses an unknown or revoked device token", async () => {
    expect(await authorise(req(bearer), async () => null)).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a family member's device: the readings are the owner's body", async () => {
    expect(await authorise(req(bearer), async () => actor("adult"))).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts the owner's paired device", async () => {
    expect(await authorise(req(bearer), async () => actor("owner"))).toMatchObject({ ok: true });
  });
});

describe("GET /api/v1/me/health body", () => {
  beforeEach(() => {
    states.mockReset();
    readings.mockReset();
    summary.mockReset();
  });

  it("reads the configured phone and leaves out the food diary", async () => {
    states.mockResolvedValue([{ entity_id: "sensor.phone_x_steps_sensor", state: "10" }]);
    readings.mockResolvedValue({ device: "phone_x", steps: 10, heartRate: null });
    summary.mockResolvedValue({
      day: "2026-10-28", targets: {}, today: {}, remaining: {}, balance: null, activeKcal: null, week: [],
      meals: [{ id: "m1", name: "secret lunch" }], coach: { message: "x" },
      water: { ml: 500, entries: [{ id: "w1", ml: 250 }] },
    });
    const r = await meHealth(req(bearer), { actorOf: async () => actor("owner") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readings.mock.calls[0]?.[1]).toBe("phone_x");
    expect(r.body.health).toMatchObject({ steps: 10, heartRate: null });
    expect(JSON.stringify(r.body)).not.toContain("secret lunch");
    expect(r.body.nutrition?.water.entries).toEqual([]);
    expect(r.body.nutrition).not.toHaveProperty("coach");
  });

  it("answers with null health, not an error, when Home Assistant is down", async () => {
    states.mockRejectedValue(new Error("down"));
    summary.mockResolvedValue({ day: "d", targets: {}, today: {}, remaining: {}, balance: null, activeKcal: null, week: [], meals: [], coach: null, water: { entries: [] } });
    const r = await meHealth(req(bearer), { actorOf: async () => actor("owner") });
    expect(r).toMatchObject({ ok: true, body: { health: null } });
    expect(readings).not.toHaveBeenCalled();
  });
});
