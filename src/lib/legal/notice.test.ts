import { describe, expect, it } from "vitest";
import { findViolations, flattenLicenses, isLicenseAllowed, isPlatformPackage, parseNoticeMarkdown, renderNotice, type RawPackage } from "./notice-core";

const pkg = (name: string, license: string, version = "1.0.0"): RawPackage => ({ name, versions: [version], license, homepage: `https://example.test/${name}` });

const fixture = (extra: Record<string, RawPackage[]> = {}) => ({
  MIT: [pkg("left-pad", "MIT")],
  "Apache-2.0": [pkg("big-sdk", "Apache-2.0")],
  "MIT OR Apache-2.0": [pkg("dual", "MIT OR Apache-2.0")],
  ...extra,
});

describe("licence allow-list", () => {
  it("accepts allowed SPDX ids", () => {
    for (const id of ["MIT", "ISC", "BSD-3-Clause", "Apache-2.0", "MPL-2.0", "AGPL-3.0", "LGPL-3.0-or-later"]) expect(isLicenseAllowed(id)).toBe(true);
  });

  it("refuses copyleft licences outside the list and unknown metadata", () => {
    for (const id of ["GPL-3.0", "GPL-2.0-only", "SSPL-1.0", "Unknown", "UNLICENSED", "", "SEE LICENSE IN LICENSE.md"]) expect(isLicenseAllowed(id)).toBe(false);
  });

  it("passes an OR expression when one branch is allowed", () => {
    expect(isLicenseAllowed("(BSD-3-Clause OR GPL-2.0)")).toBe(true);
    expect(isLicenseAllowed("MIT OR Apache-2.0")).toBe(true);
    expect(isLicenseAllowed("GPL-2.0 OR GPL-3.0")).toBe(false);
  });

  it("needs every AND term allowed", () => {
    expect(isLicenseAllowed("(MIT AND Zlib)")).toBe(true);
    expect(isLicenseAllowed("MIT AND GPL-3.0")).toBe(false);
    expect(isLicenseAllowed("(MIT OR GPL-3.0) AND ISC")).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(isLicenseAllowed("MIT OR")).toBe(false);
    expect(isLicenseAllowed("(MIT")).toBe(false);
  });
});

describe("check over fixtures", () => {
  it("allowed fixture has no violations", () => {
    expect(findViolations(flattenLicenses(fixture()))).toEqual([]);
  });

  it("an injected GPL-3.0 dependency is a violation", () => {
    const v = findViolations(flattenLicenses(fixture({ "GPL-3.0": [pkg("viral", "GPL-3.0", "2.1.0")] })));
    expect(v).toEqual([{ name: "viral", version: "2.1.0", license: "GPL-3.0" }]);
  });

  it("applies a verified override for missing metadata", () => {
    const e = flattenLicenses({ Unknown: [pkg("thirty-two", "Unknown", "1.0.2")] });
    expect(e[0]?.license).toBe("MIT");
    expect(findViolations(e)).toEqual([]);
  });
});

describe("NOTICE.md rendering", () => {
  it("is deterministic, grouped, and round-trips for the /licenses page", () => {
    const entries = flattenLicenses(fixture({ MIT: [pkg("left-pad", "MIT"), pkg("@esbuild/linux-x64", "MIT")] }));
    const md = renderNotice(entries);
    expect(renderNotice([...entries].reverse())).toBe(md);
    expect(md).not.toContain("linux-x64");
    const groups = parseNoticeMarkdown(md);
    expect(groups.map((g) => g.license).sort()).toEqual(["Apache-2.0", "MIT", "MIT OR Apache-2.0"]);
    expect(groups.find((g) => g.license === "MIT")?.packages).toEqual([{ name: "left-pad", version: "1.0.0", url: "https://example.test/left-pad" }]);
  });

  it("detects platform-specific native builds", () => {
    expect(isPlatformPackage("@next/swc-win32-x64-msvc")).toBe(true);
    expect(isPlatformPackage("@img/sharp-linux-arm64")).toBe(true);
    expect(isPlatformPackage("lightningcss-darwin-arm64")).toBe(true);
    expect(isPlatformPackage("next")).toBe(false);
    expect(isPlatformPackage("linuxify")).toBe(false);
  });
});
