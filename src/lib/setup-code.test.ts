import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fresh hub must be claimed with the code from the log / SD card, never by
// whoever reaches the page first.

async function load() {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "vatra-setup-"));
  process.env.VATRA_SETUP_CODE_FILE = join(dir, "vatra-setup-code.txt");
  return import("./setup-code");
}

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));

describe("setup code", () => {
  it("is 6 digits, persisted, stable across reads", async () => {
    const m = await load();
    const c = m.setupCode();
    expect(c).toMatch(/^\d{6}$/);
    expect(readFileSync(process.env.VATRA_SETUP_CODE_FILE!, "utf8").trim()).toBe(c);
    expect(m.setupCode()).toBe(c);
  });

  it("accepts the right code (spaces allowed) and rejects others", async () => {
    const m = await load();
    const c = m.setupCode();
    expect(m.checkSetupCode(`${c.slice(0, 3)} ${c.slice(3)}`)).toBe("ok");
    expect(m.checkSetupCode(c === "000000" ? "111111" : "000000")).toBe("wrong");
    expect(m.checkSetupCode("")).toBe("wrong");
  });

  it("locks after 10 wrong guesses (LAN brute force)", async () => {
    const m = await load();
    const c = m.setupCode();
    const bad = c === "123456" ? "654321" : "123456";
    for (let i = 0; i < 10; i++) m.checkSetupCode(bad);
    expect(m.checkSetupCode(c)).toBe("locked");
  });

  it("is burned after the claim", async () => {
    const m = await load();
    m.setupCode();
    m.burnSetupCode();
    expect(readFileSync(process.env.VATRA_SETUP_CODE_FILE!, "utf8").trim()).toBe("claimed");
  });
});

describe("unclaimed hub", () => {
  it("grants no home actor before the first account (used to be a solo owner)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({ authEnabled: async () => false, getCurrentUser: async () => null }));
    vi.doMock("@/lib/home/house", () => ({ houseRooms: () => [{ id: "r", name: "R", x: 0, y: 0, w: 1, h: 1 }], houseDevices: () => [] }));
    vi.doMock("@/lib/db", () => ({ db: {} }));
    delete process.env.VMUI_SOLO_MODE;
    const a = await import("@/lib/home/access");
    expect(await a.currentHomeActor()).toBeNull();
    expect(await a.ownerActor()).toBeNull();
    expect(await a.tokenActor(new Request("http://hub/api/lights?k=x"))).toBeNull();
  });
});
