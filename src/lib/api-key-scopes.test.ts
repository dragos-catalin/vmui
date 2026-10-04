import { describe, expect, it } from "vitest";
import { argsAllowed, isUnrestricted, parseApiKeyScopes, presetScopes, presetTools, STREAM_PRESET, toolAllowed } from "./api-key-scopes";

const catalog = [
  { name: "vm_list", readOnly: true },
  { name: "vm_sync" },
  { name: "vm_action", destructive: true },
  { name: "door_open", destructive: true },
];

describe("api-key scopes", () => {
  it("null scopes are unrestricted", () => {
    expect(toolAllowed(catalog[2]!, null)).toBe(true);
    expect(argsAllowed({ kind: "vm", id: "x" }, null)).toBe(true);
    expect(isUnrestricted(null)).toBe(true);
    expect(parseApiKeyScopes(null)).toBeNull();
  });

  it("tool allow-list is enforced and filters presets", () => {
    const scopes = { tools: ["vm_list"] };
    expect(toolAllowed(catalog[0]!, scopes)).toBe(true);
    expect(toolAllowed(catalog[2]!, scopes)).toBe(false);
    expect(presetTools("readOnly", catalog)).toEqual(["vm_list"]);
    expect(presetTools("nonDestructive", catalog)).toEqual(["vm_list", "vm_sync"]);
    expect(presetTools("all", catalog)).toBeUndefined();
  });

  it("argument scopes deny anything not listed, including the vm_sync wildcard", () => {
    const scopes = { vmIds: ["acct-1"], entities: ["light.desk"] };
    expect(argsAllowed({ kind: "vm", id: "acct-1" }, scopes)).toBe(true);
    expect(argsAllowed({ kind: "vm", id: "acct-2" }, scopes)).toBe(false);
    expect(argsAllowed({ kind: "vm", id: "*" }, scopes)).toBe(false);
    expect(argsAllowed({ kind: "entity", id: "light.desk" }, scopes)).toBe(true);
    // unscoped dimension stays open
    expect(argsAllowed({ kind: "pc", id: "lock" }, scopes)).toBe(true);
  });

  it("malformed stored scopes fail closed", () => {
    for (const raw of ["{not json", '{"tools": "vm_list"}', '{"tools": [1, 2]}']) {
      const scopes = parseApiKeyScopes(raw);
      expect(scopes).not.toBeNull();
      expect(toolAllowed(catalog[0]!, scopes)).toBe(false);
      expect(isUnrestricted(scopes)).toBe(false);
    }
  });

  it("round-trips valid JSON", () => {
    expect(parseApiKeyScopes('{"tools":["vm_list"],"pcActions":["lock"]}')).toEqual({ tools: ["vm_list"], pcActions: ["lock"] });
  });

  describe("stream preset", () => {
    const full = [
      ...catalog,
      ...["home_devices", "home_state", "scene_list"].map((name) => ({ name, readOnly: true })),
      ...["scene_set", "flash_color", "notify_flash", "ambilight_mode", "lights_set", "lights_all", "ha_script"].map((name) => ({ name })),
      { name: "pc_action", destructive: true },
    ];

    it("resolves to exactly the stream tools present in the catalog", () => {
      expect(presetTools("stream", full)?.sort()).toEqual(
        ["home_devices", "home_state", "scene_list", "scene_set", "flash_color", "notify_flash", "ambilight_mode", "lights_set"].sort(),
      );
      expect(presetTools("stream", catalog)).toEqual([]);
    });

    it("carries entity and script limits so lights_set reaches only RGB room lights", () => {
      const scopes = presetScopes("stream", full)!;
      for (const denied of ["vm_list", "door_open", "pc_action", "lights_all", "ha_script"]) {
        expect(toolAllowed({ name: denied }, scopes)).toBe(false);
      }
      expect(toolAllowed({ name: "scene_set" }, scopes)).toBe(true);
      expect(argsAllowed({ kind: "entity", id: "light.moodlight" }, scopes)).toBe(true);
      expect(argsAllowed({ kind: "entity", id: "light.desk_light_bar" }, scopes)).toBe(false);
      expect(argsAllowed({ kind: "entity", id: "climate.bedroom_ac" }, scopes)).toBe(false);
      expect(argsAllowed({ kind: "script", id: "stream_scene_party" }, scopes)).toBe(true);
      expect(argsAllowed({ kind: "script", id: "movie_mode_on" }, scopes)).toBe(false);
      expect(scopes.entities).toEqual(STREAM_PRESET.entities);
    });

    it("survives the stored-JSON round trip", () => {
      const scopes = presetScopes("stream", full)!;
      expect(parseApiKeyScopes(JSON.stringify(scopes))).toEqual(scopes);
      expect(presetScopes("all", full)).toBeUndefined();
      expect(presetScopes("readOnly", full)).toEqual({ tools: presetTools("readOnly", full) });
    });
  });
});
