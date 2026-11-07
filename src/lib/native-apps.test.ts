import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The native apps take brand tokens and strings from generated files; a stale one means an app ships
// different colours or a missing Romanian text than the hub. Both generators have a --check mode.
const run = (script: string) => execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });

describe("native app generated sources", () => {
  it("Android brand tokens and icons match brand/tokens", () => {
    expect(run("brand/scripts/emit-compose.mjs")).toContain("up to date");
  });

  it("iOS brand tokens match brand/tokens", () => {
    expect(run("brand/scripts/emit-swift.mjs")).toContain("up to date");
  });

  it("iOS strings are complete in en and ro and cover every key the Swift code uses", () => {
    expect(run("apps/ios/scripts/strings.mjs")).toContain("en + ro");
  });
});
