import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HaState } from "@/lib/home/ha-client";
import { planImport } from "@/lib/home/ha-import";
import { resetSim, simRest, simStateChanges, simWsCommands } from "./sim-ha";

const post = (path: string, body: unknown) => simRest<unknown>(path, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => resetSim());
afterEach(() => resetSim());

describe("simulated Home Assistant", () => {
  it("a light service call changes the state and emits state_changed", async () => {
    const ac = new AbortController();
    const it = simStateChanges(ac.signal);
    const next = it.next();
    await post("/services/light/turn_on", { entity_id: "light.kitchen", brightness_pct: 50 });
    const ev = (await next).value as HaState;
    expect(ev.entity_id).toBe("light.kitchen");
    expect(ev.state).toBe("on");
    expect(ev.attributes.brightness).toBe(128);
    const st = await simRest<HaState>("/states/light.kitchen");
    expect(st.state).toBe("on");
    ac.abort();
    await it.return(undefined);
  });

  it("applies rgb only to rgb lights, toggles, locks and climate", async () => {
    await post("/services/light/turn_on", { entity_id: "light.bedroom", rgb_color: [10, 20, 30] });
    expect((await simRest<HaState>("/states/light.bedroom")).attributes.rgb_color).toEqual([10, 20, 30]);
    await post("/services/light/toggle", { entity_id: "light.bedroom" });
    expect((await simRest<HaState>("/states/light.bedroom")).state).toBe("off");
    await post("/services/lock/unlock", { entity_id: "lock.front_door" });
    expect((await simRest<HaState>("/states/lock.front_door")).state).toBe("unlocked");
    await post("/services/climate/set_temperature", { entity_id: "climate.living_room_ac", temperature: 21.5 });
    const ac = await simRest<HaState>("/states/climate.living_room_ac");
    expect(ac.attributes.temperature).toBe(21.5);
    await post("/services/climate/turn_off", { entity_id: "climate.living_room_ac" });
    expect((await simRest<HaState>("/states/climate.living_room_ac")).state).toBe("off");
  });

  it("runs every script the hub calls, forecasts, and aborts config flows with reason demo", async () => {
    await expect(post("/services/script/ambilight_all", { commands: "[]" })).resolves.toBeDefined();
    await post("/services/script/stream_scene_party", {});
    expect((await simRest<HaState>("/states/light.living_room")).attributes.rgb_color).toEqual([255, 0, 200]);
    const r = (await post("/services/weather/get_forecasts?return_response", { entity_id: "weather.home", type: "daily" })) as { service_response: Record<string, { forecast: unknown[] }> };
    expect(r.service_response["weather.home"]?.forecast).toHaveLength(7);
    const flow = (await post("/config/config_entries/flow", { handler: "esphome" })) as { type: string; reason: string };
    expect(flow).toMatchObject({ type: "abort", reason: "demo" });
    await expect(simRest("/states/light.nope")).rejects.toThrow(/404/);
  });

  it("registries import into 4 rooms with their devices", async () => {
    const [areas, devices, entities, states] = await simWsCommands<[never, never, never, HaState[]]>(["config/area_registry/list", "config/device_registry/list", "config/entity_registry/list", "get_states"]);
    const plan = planImport(areas, devices, entities, states, { roomIds: new Set(), deviceIds: new Set(), entities: new Set(), areaToRoom: new Map() });
    expect(plan.rooms.map((r) => r.id).sort()).toEqual(["bedroom", "hallway", "kitchen", "living_room"]);
    const kinds = new Map(plan.devices.map((d) => [d.entity, d.kind]));
    expect(kinds.get("climate.living_room_ac")).toBe("ac");
    expect(kinds.get("lock.front_door")).toBe("door");
    expect(kinds.get("light.living_room")).toBe("light");
  });
});
