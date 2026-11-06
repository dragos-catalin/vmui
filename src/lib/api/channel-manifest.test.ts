import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// P4-02: the channel manifest only ever carries digest-pinned images.

const run = (...a: string[]) => execFileSync(process.execPath, ["scripts/channel-manifest.mjs", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const D = `sha256:${"a".repeat(64)}`;

describe("channel manifest", () => {
  it("pins every image by digest and carries the API contract", () => {
    const m = JSON.parse(run("--channel", "beta", "--version", "0.4.0", "--image", `ghcr.io/o/vatra@${D}`)) as { images: Record<string, string>; apiVersion: number; minClient: number };
    expect(Object.keys(m.images).sort()).toEqual(["ESPHOME_IMAGE", "HA_IMAGE", "MOSQUITTO_IMAGE", "VATRA_IMAGE"]);
    for (const v of Object.values(m.images)) expect(v).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(m.apiVersion).toBeGreaterThanOrEqual(m.minClient);
  });

  it("refuses a tag instead of a digest", () => {
    expect(() => run("--channel", "beta", "--version", "0.4.0", "--image", "ghcr.io/o/vatra:0.4.0")).toThrow();
  });

  it("refuses an unknown channel", () => {
    expect(() => run("--channel", "latest", "--version", "0.4.0", "--image", `ghcr.io/o/vatra@${D}`)).toThrow();
  });

  it("compose refuses to start without pins", () => {
    const c = readFileSync("deploy/vatra/compose.yaml", "utf8");
    for (const k of ["VATRA_IMAGE", "HA_IMAGE", "ESPHOME_IMAGE", "MOSQUITTO_IMAGE"]) expect(c).toContain(`\${${k}:?`);
    expect(c).not.toMatch(/image: .*:(latest|stable)\s*$/m);
  });
});
