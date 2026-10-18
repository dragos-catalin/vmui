import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
let pcOnline = true;

const haStates = () => [
  { entity_id: "light.moodlight", state: "on", attributes: { friendly_name: "Moodlight", supported_color_modes: ["rgb", "color_temp"], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, rgb_color: [10, 20, 30], brightness: 128, effect_list: ["Rainbow"] }, last_changed: "", last_updated: "" },
  { entity_id: "light.desk_light_bar", state: "off", attributes: { supported_color_modes: ["hs", "color_temp"], min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500 }, last_changed: "", last_updated: "" },
  { entity_id: "light.led_argb", state: "on", attributes: { supported_color_modes: ["rgb"] }, last_changed: "", last_updated: "" },
  { entity_id: "light.hyperhdr", state: "on", attributes: { supported_color_modes: ["rgb"] }, last_changed: "", last_updated: "" },
  { entity_id: "light.plug", state: "off", attributes: { supported_color_modes: ["onoff"] }, last_changed: "", last_updated: "" },
  { entity_id: "sensor.vmui_pc_agent", state: pcOnline ? "online" : "offline", attributes: { at: Math.floor(Date.now() / 1000) }, last_changed: "", last_updated: "" },
];

vi.mock("@/lib/home/ha-client", () => ({
  ha: {
    states: async () => haStates(),
    state: async (id: string) => haStates().find((s) => s.entity_id === id) ?? null,
    callService: async (domain: string, service: string, data: Record<string, unknown>) => {
      calls.push({ domain, service, data });
      return [];
    },
  },
}));

type Registry = typeof import("./registry");
type Control = typeof import("./control");
let registry: Registry;
let control: Control;

beforeAll(async () => {
  process.env.VMUI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "vmui-lights-")), "t.db");
  globalThis.__vmui_sqlite__ = undefined;
  registry = await import("./registry");
  control = await import("./control");
  await registry.seedFromHa();
});

beforeEach(() => {
  calls.length = 0;
  pcOnline = true;
});

describe("seedFromHa", () => {
  it("adds HA lights, skips hyperhdr and the MELK alias, and seeds the BLE strip", () => {
    const ids = registry.list().map((d) => d.id).sort();
    expect(ids).toEqual(["desk_light_bar", "melk_oa10", "moodlight", "plug"]);
  });
  it("derives capabilities from colour modes and marks the desk bar white-only", () => {
    const mood = registry.mustGet("moodlight");
    expect(mood.capabilities).toMatchObject({ rgb: true, brightness: true, kelvin: [2200, 6500], effects: ["Rainbow"], whiteOnly: false });
    const bar = registry.mustGet("desk_light_bar");
    expect(bar.capabilities.whiteOnly).toBe(true);
    expect(bar.capabilities.rgb).toBe(false);
    expect(registry.mustGet("plug").capabilities.brightness).toBe(false);
  });
  it("is idempotent", async () => {
    const r = await registry.seedFromHa();
    expect(r.added).toEqual([]);
    expect(registry.list()).toHaveLength(4);
  });
  it("gives the MELK strip one whole-strip segment", () => {
    const melk = registry.mustGet("melk_oa10");
    expect(melk.segments).toHaveLength(1);
    expect(melk.haEntity).toBe("light.led_argb");
  });
});

describe("segments", () => {
  it("appends with prefix-sum starts and keeps led_count as the sum", () => {
    registry.updateDevice("melk_oa10", { ledCount: 30 });
    const seg = registry.addSegment("melk_oa10", { name: "Birou", ledCount: 20 });
    expect(seg).toMatchObject({ ord: 1, ledStart: 30 });
    expect(registry.mustGet("melk_oa10").ledCount).toBe(50);
  });
  it("reorders and recomputes starts", () => {
    const segs = registry.mustGet("melk_oa10").segments;
    const reordered = registry.reorder("melk_oa10", segs.map((s) => s.id).reverse());
    expect(reordered.map((s) => s.ledStart)).toEqual([0, 20]);
  });
});

describe("setLight", () => {
  it("drives an HA light with calibrated values and logs before/after", async () => {
    registry.updateDevice("moodlight", { calibration: { gains: [1, 0.5, 1] } });
    const r = await control.setLight("dev:moodlight", { on: true, rgb: [200, 200, 200], brightnessPct: 50 }, "test");
    expect(r.ok).toBe(true);
    expect(r.applied[0]?.via).toBe("ha");
    expect(calls[0]).toMatchObject({ domain: "light", service: "turn_on", data: { entity_id: "light.moodlight", rgb_color: [200, 100, 200], brightness_pct: 50 } });
  });
  it("never sends rgb to the white-only desk bar", async () => {
    await control.setLight("dev:desk_light_bar", { on: true, rgb: [255, 0, 0] }, "test");
    expect(calls[0]?.data.rgb_color).toBeUndefined();
    expect(calls[0]?.data.color_temp_kelvin).toBe(3000);
  });
  it("sends BLE lights through the PC MQTT relay with the segment range", async () => {
    const seg = registry.mustGet("melk_oa10").segments[1]!;
    const r = await control.setLight(`seg:${seg.id}`, { on: true, rgb: [1, 2, 3] }, "test");
    expect(r.applied[0]?.via).toBe("pc_ble");
    expect(calls[0]).toMatchObject({ domain: "mqtt", service: "publish", data: { topic: "vmui/pc/cmd", qos: 1 } });
    const payload = JSON.parse(String(calls[0]?.data.payload));
    expect(payload).toMatchObject({ action: "light", device: { mac: "BE:69:83:00:C4:0B", protocol: "melk" }, segment: { start: seg.ledStart, count: seg.ledCount }, state: { on: true, rgb: [1, 2, 3] } });
    expect(typeof payload.id).toBe("string");
    expect(typeof payload.at).toBe("number");
  });
  it("falls back to the HA alias when the PC agent is offline", async () => {
    pcOnline = false;
    const r = await control.setLight("dev:melk_oa10", { on: false }, "test");
    expect(r.applied[0]?.via).toBe("ha_alias");
    expect(calls[0]).toMatchObject({ domain: "light", service: "turn_off", data: { entity_id: "light.led_argb" } });
  });
  it("undo re-applies the previous state", async () => {
    await control.setLight("dev:moodlight", { on: false }, "test");
    calls.length = 0;
    const r = await control.undo("test");
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ service: "turn_on", data: { entity_id: "light.moodlight" } });
  });
  it("rejects a target that matches nothing", async () => {
    await expect(control.setLight("dev:nope", { on: true }, "test")).rejects.toMatchObject({ code: "noDevices" });
  });
});

describe("export / import", () => {
  it("round-trips the registry", () => {
    const dump = registry.exportJson();
    const r = registry.importJson(JSON.stringify(dump));
    expect(r.devices).toBe(4);
    expect(registry.mustGet("melk_oa10").segments).toHaveLength(2);
    expect(registry.list()).toHaveLength(4);
  });
});
