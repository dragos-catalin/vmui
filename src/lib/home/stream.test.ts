import { describe, expect, it } from "vitest";
import { STREAM_SCENES, STREAM_SCRIPTS } from "./catalog";
import { flashColorSchema, resolveFlashColor, resolveScene, sceneScopeId, sceneSetSchema } from "./stream";
import streamPreset from "@/lib/mcp/stream-preset.json";

describe("scene_set input", () => {
  it("accepts a known scene and applies the default duration", () => {
    const p = sceneSetSchema.parse({ scene: "party" });
    expect(resolveScene(p)).toEqual({ id: "party", script: "stream_scene_party", durationSec: 20 });
  });

  it("rejects unknown scenes and durations over the scene cap", () => {
    expect(sceneSetSchema.safeParse({ scene: "strobe" }).success).toBe(false);
    expect(sceneSetSchema.safeParse({ scene: "red_alert", durationSec: 21 }).success).toBe(false);
    expect(sceneSetSchema.safeParse({ scene: "red_alert", durationSec: 20 }).success).toBe(true);
    expect(sceneSetSchema.safeParse({ scene: "calm", durationSec: 0 }).success).toBe(false);
    expect(sceneSetSchema.safeParse({ scene: "party", idempotencyKey: "" }).success).toBe(false);
  });

  it("default restores immediately whatever duration is passed", () => {
    expect(resolveScene({ scene: "default", durationSec: 30 })).toEqual({ id: "default", script: "stream_scene_default", durationSec: 0 });
  });

  it("scope ids line up with the stream preset scripts", () => {
    for (const s of STREAM_SCENES) expect(streamPreset.scripts).toContain(sceneScopeId(s.id));
    expect([...streamPreset.scripts].sort()).toEqual([...STREAM_SCRIPTS].sort());
    expect(sceneScopeId(42)).toBeUndefined();
  });
});

describe("flash_color input", () => {
  it("takes a colour name or rgb, with defaults", () => {
    const p = flashColorSchema.parse({ color: "gold" });
    expect(p).toMatchObject({ count: 1, durationMs: 600 });
    expect(resolveFlashColor(p)).toEqual([255, 180, 0]);
    expect(resolveFlashColor(flashColorSchema.parse({ rgb: [1, 2, 3], count: 5 }))).toEqual([1, 2, 3]);
  });

  it("rejects both/neither colour, out-of-range count and duration", () => {
    expect(flashColorSchema.safeParse({}).success).toBe(false);
    expect(flashColorSchema.safeParse({ rgb: [1, 2, 3], color: "red" }).success).toBe(false);
    expect(flashColorSchema.safeParse({ color: "red", count: 6 }).success).toBe(false);
    expect(flashColorSchema.safeParse({ color: "red", count: 0 }).success).toBe(false);
    expect(flashColorSchema.safeParse({ color: "red", durationMs: 199 }).success).toBe(false);
    expect(flashColorSchema.safeParse({ color: "red", durationMs: 5001 }).success).toBe(false);
    expect(flashColorSchema.safeParse({ rgb: [256, 0, 0] }).success).toBe(false);
    expect(flashColorSchema.safeParse({ color: "chartreuse" }).success).toBe(false);
  });
});

describe("stream catalogue", () => {
  it("never targets the white-only desk bar", () => {
    expect(JSON.stringify(STREAM_SCENES)).not.toContain("desk_light_bar");
    expect(streamPreset.entities).not.toContain("light.desk_light_bar");
  });
});
