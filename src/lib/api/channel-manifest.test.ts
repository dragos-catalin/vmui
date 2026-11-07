import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  describe("os block (P5-04)", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const H = `sha512-256:${"b".repeat(64)}`;
    const index = (platforms: Record<string, unknown>, version = "1.2.0") => {
      const d = mkdtempSync(join(tmpdir(), "os-index-"));
      dirs.push(d);
      writeFileSync(join(d, "vatra-os-x86-1.2.0.rugixb"), "x86 bundle");
      writeFileSync(join(d, "vatra-os-pi5-1.2.0.rugixb"), "pi5 bundle!");
      const p = join(d, "os-index.json");
      writeFileSync(p, JSON.stringify({ version, platforms }));
      return p;
    };
    const base = ["--channel", "stable", "--version", "0.6.0", "--image", `ghcr.io/o/vatra@${D}`];
    const url = "https://github.com/o/vmui/releases/download/v0.6.0/";

    it("carries url, sha256 and size of every bundle so the signature covers them", () => {
      const p = index({ x86: { file: "vatra-os-x86-1.2.0.rugixb", bundleHash: H }, pi5: { file: "vatra-os-pi5-1.2.0.rugixb", bundleHash: H } });
      const m = JSON.parse(run(...base, "--os-index", p, "--os-base-url", url)) as { os: { version: string; platforms: Record<string, { url: string; sha256: string; size: number; bundleHash: string }> } };
      expect(m.os.version).toBe("1.2.0");
      expect(Object.keys(m.os.platforms).sort()).toEqual(["pi5", "x86"]);
      expect(m.os.platforms.x86).toEqual({
        url: `${url}vatra-os-x86-1.2.0.rugixb`,
        sha256: createHash("sha256").update("x86 bundle").digest("hex"),
        size: 10,
        bundleHash: H,
      });
      expect(m.os.platforms.pi5?.size).toBe(11);
    });

    it("is absent without --os-index", () => {
      expect(JSON.parse(run(...base))).not.toHaveProperty("os");
    });

    it("refuses unknown platforms, path tricks, bad hashes and plain http", () => {
      expect(() => run(...base, "--os-index", index({ riscv: { file: "vatra-os-x86-1.2.0.rugixb", bundleHash: H } }), "--os-base-url", url)).toThrow();
      expect(() => run(...base, "--os-index", index({ x86: { file: "../vatra-os-x86-1.2.0.rugixb", bundleHash: H } }), "--os-base-url", url)).toThrow();
      expect(() => run(...base, "--os-index", index({ x86: { file: "vatra-os-x86-1.2.0.rugixb", bundleHash: "nope" } }), "--os-base-url", url)).toThrow();
      expect(() => run(...base, "--os-index", index({ x86: { file: "vatra-os-x86-1.2.0.rugixb", bundleHash: H } }), "--os-base-url", "http://x/")).toThrow();
      expect(() => run(...base, "--os-index", index({ x86: { file: "vatra-os-x86-1.2.0.rugixb", bundleHash: H } }, "1.2"), "--os-base-url", url)).toThrow();
    });
  });

  it("compose refuses to start without pins", () => {
    const c = readFileSync("deploy/vatra/compose.yaml", "utf8");
    for (const k of ["VATRA_IMAGE", "HA_IMAGE", "ESPHOME_IMAGE", "MOSQUITTO_IMAGE"]) expect(c).toContain(`\${${k}:?`);
    expect(c).not.toMatch(/image: .*:(latest|stable)\s*$/m);
  });
});
