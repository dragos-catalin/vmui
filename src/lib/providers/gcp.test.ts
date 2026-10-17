import { describe, expect, it } from "vitest";

import { detectPlatform, macIapConnectionInfo } from "./gcp";

describe("gcp provider: devcloud macOS host (DC-053)", () => {
  it("labels role=mac make the Ubuntu OSX-KVM host a macOS instance", () => {
    expect(detectPlatform("c4-standard-16", "vmui-mac", { app: "devcloud", role: "mac" })).toBe("macos");
  });

  it("keeps the old heuristics without the label", () => {
    expect(detectPlatform("e2-small", "win-build", null)).toBe("windows");
    expect(detectPlatform("c4-standard-16", "vmui-mac", { app: "devcloud" })).toBe("linux");
    expect(detectPlatform("e2-small", "web", undefined)).toBe("linux");
  });

  it("connection info points at the IAP tunnel and the same local ports as the WSL VM", () => {
    const c = macIapConnectionInfo("vmui-mac", "europe-central2-a", "dragos-devcloud");
    expect(c).toMatchObject({ protocol: "vnc", host: "127.0.0.1", port: 5900, vncUrl: "vnc://127.0.0.1:5900" });
    expect(c.sshCommand).toBe("ssh dragos@127.0.0.1 -p 10022");
    expect(c.notes.join("\n")).toContain("mac-gce.ps1 -Name vmui-mac -Zone europe-central2-a -Project dragos-devcloud -Tunnel");
  });

  it("with a tailnet label it offers the MagicDNS name first and keeps IAP as the fallback", () => {
    const c = macIapConnectionInfo("vmui-mac", "europe-central2-a", "dragos-devcloud", "taild1532d");
    expect(c).toMatchObject({ host: "vmui-mac.taild1532d.ts.net", port: 5900, vncUrl: "vnc://vmui-mac.taild1532d.ts.net:5900" });
    expect(c.sshCommand).toBe("ssh dragos@vmui-mac.taild1532d.ts.net -p 10022");
    expect(c.notes.join("\n")).toContain("-Tunnel");
  });

  it("ignores a malformed tailnet label", () => {
    expect(macIapConnectionInfo("vmui-mac", "z", "p", "evil.example/x").host).toBe("127.0.0.1");
  });
});
