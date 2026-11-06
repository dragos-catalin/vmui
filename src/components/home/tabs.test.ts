import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "./tabs";

describe("settings groups", () => {
  it("place every settings section in exactly one group", () => {
    const grouped = SETTINGS_GROUPS.flatMap((g) => [...g.sections]);
    expect([...grouped].sort()).toEqual([...SETTINGS_SECTIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("keep owner-specific integrations under extensions", () => {
    expect(SETTINGS_GROUPS.find((g) => g.id === "extensions")?.sections).toContain("copilot");
  });
});
