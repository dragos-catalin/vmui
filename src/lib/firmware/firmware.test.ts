import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// P6-03/P6-04: the hub serves only what a manifest names, and adopts only boards on the LAN.

vi.mock("@/lib/notify", () => ({ notify: async () => null, dismissByTag: async () => undefined }));
vi.mock("@/lib/household", () => ({ household: () => ({ publicUrl: undefined, locale: "en", timeZone: "UTC" }) }));
const haMock = { configured: () => true, flowStart: vi.fn(), flowStep: vi.fn(), flowAbort: vi.fn(async () => null) };
vi.mock("@/lib/home/ha-client", () => ({ ha: haMock }));

const root = mkdtempSync(join(tmpdir(), "vatra-fw-"));
let S: typeof import("./store");
let A: typeof import("./adopt");

const manifest = (id: string, v = "1.2.0") => ({
  name: `Vatra ${id}`,
  version: v,
  builds: [{ chipFamily: "ESP32", parts: [{ path: `${id}-${v}.factory.bin`, offset: 0 }], ota: { path: `${id}-${v}.ota.bin`, md5: "0123456789abcdef0123456789abcdef" } }],
  vatra: { id, project: "vatra.display" },
});

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-fwdb-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  process.env.VATRA_FIRMWARE_DIR = root;
  for (const id of ["vatra-display-oled", "vatra-button-c3"]) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "manifest.json"), JSON.stringify(manifest(id)));
    writeFileSync(join(root, id, `${id}-1.2.0.factory.bin`), "F");
    writeFileSync(join(root, id, `${id}-1.2.0.ota.bin`), "O");
    writeFileSync(join(root, id, "secret.txt"), "nope");
  }
  mkdirSync(join(root, "vatra-broken"));
  writeFileSync(join(root, "vatra-broken", "manifest.json"), "{oops");
  S = await import("./store");
  A = await import("./adopt");
});

afterEach(() => vi.unstubAllGlobals());

describe("firmware store", () => {
  it("lists valid images only, with their kind", () => {
    const ids = S.listImages().map((i) => [i.id, i.kind, i.version]);
    expect(ids).toEqual([
      ["vatra-button-c3", "button", "1.2.0"],
      ["vatra-display-oled", "display", "1.2.0"],
    ]);
  });

  it("serves only files the manifest names", () => {
    expect(S.imageFile("vatra-display-oled", "vatra-display-oled-1.2.0.ota.bin")).not.toBeNull();
    expect(S.imageFile("vatra-display-oled", "secret.txt")).toBeNull();
    expect(S.imageFile("vatra-display-oled", "../vatra-button-c3/vatra-button-c3-1.2.0.ota.bin")).toBeNull();
    expect(S.imageFile("../etc", "passwd")).toBeNull();
    expect(S.loadImage("vatra-broken")).toBeNull();
  });
});

describe("LAN guard", () => {
  it("accepts private IPv4 and .local names only", () => {
    for (const h of ["192.168.1.50", "10.0.0.7", "172.16.4.2", "vatra-display-oled-a1b2c3.local"]) expect(A.isLanHost(h), h).toBe(true);
    for (const h of ["8.8.8.8", "169.254.169.254x", "metadata.google.internal", "192.168.1.50:80", "192.168.1.50/x", "172.32.0.1", "192.168.300.1", "evil.com", "a.local.evil.com", "evil.com/x.local", "a b.local", "x.y.local", "-x.local", "user@x.local"]) expect(A.isLanHost(h), h).toBe(false);
  });
});

describe("mDNS answers", () => {
  it("fold PTR/SRV/TXT/A into one Vatra node", () => {
    const inst = "vatra-button-c3-a1b2c3._esphomelib._tcp.local";
    const m = A.collectEsp([
      { name: "_esphomelib._tcp.local", type: "PTR", data: inst },
      { name: inst, type: "SRV", data: { target: "vatra-button-c3-a1b2c3.local", port: 6053 } },
      { name: inst, type: "TXT", data: [Buffer.from("project_name=vatra.button"), Buffer.from("project_version=1.2.0"), Buffer.from("friendly_name=Desk button")] },
      { name: "vatra-button-c3-a1b2c3.local", type: "A", data: "192.168.1.77" },
    ]);
    expect([...m.values()]).toEqual([
      { host: "vatra-button-c3-a1b2c3.local", ip: "192.168.1.77", name: "vatra-button-c3-a1b2c3", friendlyName: "Desk button", project: "vatra.button", version: "1.2.0", mac: null, vatra: true },
    ]);
  });
});

describe("hub address for a board", () => {
  const nets = { eth0: [{ address: "192.168.100.232", netmask: "255.255.255.0", family: "IPv4", internal: false }], tailscale0: [{ address: "100.64.1.2", netmask: "255.192.0.0", family: "IPv4", internal: false }] } as unknown as NodeJS.Dict<NetworkInterfaceInfo[]>;
  it("picks the hub's address on the board's subnet", () => {
    expect(A.hubUrlFor("192.168.100.40", nets, 3737)).toBe("http://192.168.100.232:3737");
  });
  it("falls back to a private address when no subnet matches", () => {
    expect(A.hubUrlFor("10.9.9.9", nets, 3737)).toBe("http://192.168.100.232:3737");
  });
});

describe("adoption", () => {
  type Call = { url: string; method: string };
  function board(opts: { image?: string; adopted?: boolean; acceptToken?: boolean }) {
    const calls: Call[] = [];
    let token = "";
    let adopted = opts.adopted ?? false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ url: u.pathname + u.search, method: init?.method ?? "GET" });
      const path = decodeURIComponent(u.pathname);
      if (path === "/text_sensor/Vatra firmware") return Response.json({ value: `${opts.image ?? "vatra-button-c3"}@1.2.0` });
      if (path === "/text_sensor/Vatra adopted") return Response.json({ value: adopted ? "yes" : "no" });
      if (path === "/text/Vatra hub/set") return new Response("");
      if (path === "/text/Vatra token/set") {
        token = u.searchParams.get("value") ?? "";
        if (opts.acceptToken !== false && token.startsWith("vmd_")) adopted = true;
        return new Response("");
      }
      return new Response("", { status: 404 });
    });
    return { calls, token: () => token };
  }

  it("writes the hub then a scoped token, verifies, and offers the board to HA", async () => {
    haMock.flowStart.mockResolvedValueOnce({ type: "form", flow_id: "f1", step_id: "user" });
    haMock.flowStep.mockResolvedValueOnce({ type: "create_entry" });
    const b = board({});
    const r = await A.adoptEsp({ host: "192.168.1.77", hubUrl: "http://192.168.1.2:3737", by: "test", ownerUserId: null });
    expect(r).toMatchObject({ ok: true, image: "vatra-button-c3", ha: "added" });
    const sets = b.calls.filter((c) => c.method === "POST").map((c) => decodeURIComponent(c.url.split("?")[0] ?? ""));
    expect(sets).toEqual(["/text/Vatra hub/set", "/text/Vatra token/set"]);
    expect(b.token()).toMatch(/^vmd_/);
    expect(haMock.flowStep).toHaveBeenCalledWith("f1", { host: "192.168.1.77", port: 6053 });
    // the token works on the button route and nowhere else
    const { espAuthorized } = await import("@/lib/esp/auth");
    const req = (p: string) => new Request(`http://hub${p}`, { headers: { authorization: `Bearer ${b.token()}` } });
    expect(espAuthorized(req("/api/esp/button"))).toBe(true);
    expect(espAuthorized(req("/api/turzx/state"))).toBe(false);
  });

  it("refuses a board that already belongs to a hub, without minting", async () => {
    const b = board({ adopted: true });
    expect(await A.adoptEsp({ host: "192.168.1.78", hubUrl: "http://h", by: "t", ownerUserId: null })).toEqual({ ok: false, error: "already_adopted" });
    expect(b.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("revokes the minted token when the board does not take it", async () => {
    const b = board({ acceptToken: false });
    expect(await A.adoptEsp({ host: "192.168.1.79", hubUrl: "http://h", by: "t", ownerUserId: null, addHa: false })).toEqual({ ok: false, error: "refused" });
    const { espAuthorized } = await import("@/lib/esp/auth");
    expect(espAuthorized(new Request("http://hub/api/esp/button", { headers: { authorization: `Bearer ${b.token()}` } }))).toBe(false);
  });

  it("never opens a socket to a non-LAN host", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await A.adoptEsp({ host: "169.254.169.254.nip.io", by: "t", ownerUserId: null })).toEqual({ ok: false, error: "bad_host" });
    expect(f).not.toHaveBeenCalled();
  });

  it("leaves no half-open HA flow when HA wants the key", async () => {
    haMock.flowStart.mockResolvedValueOnce({ type: "form", flow_id: "f2" });
    haMock.flowStep.mockResolvedValueOnce({ type: "form", step_id: "encryption_key" });
    expect(await A.addToHa("192.168.1.80")).toBe("needs_key");
    expect(haMock.flowAbort).toHaveBeenCalledWith("f2");
  });
});
