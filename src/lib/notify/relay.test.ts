import { createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LocalizedCard } from "./index";

vi.mock("@/lib/cloud/identity", () => ({ cloudEndpoints: () => ({ api: "https://push.test" }), hubJwt: () => "jwt" }));

const { relayRequests, sealCard, sendRelay } = await import("./relay");

const card = (over: Partial<LocalizedCard> = {}): LocalizedCard =>
  ({
    id: "c1",
    kind: "intercom",
    tag: "door",
    title: "Sună la ușă",
    body: "Interfon principal",
    subtitle: "Poarta",
    color: "#ff8800",
    icon: "door",
    image: null,
    priority: "high",
    progress: null,
    actions: [{ id: "open", label: "Deschide", style: "primary" }],
    url: null,
    sticky: false,
    dismissedAt: null,
    updatedAt: new Date(1_700_000_000_000),
    ...over,
  }) as unknown as LocalizedCard;

const KEY = randomBytes(32);
const H = `h1.${"a".repeat(40)}`;
const HA = `h1.${"b".repeat(40)}`;

function open(e: string, key: Buffer, aad: string): string {
  const buf = Buffer.from(e, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8");
}

describe("sealCard", () => {
  it("round-trips the UnifiedPush payload, bound to the card id", () => {
    const { e, full } = sealCard(card(), KEY);
    expect(full).toBe("1");
    const plain = JSON.parse(open(e, KEY, "c1")) as Record<string, string>;
    expect(plain).toMatchObject({ type: "card", id: "c1", kind: "intercom", title: "Sună la ușă", body: "Interfon principal" });
    expect(() => open(e, KEY, "c2")).toThrow();
    expect(() => open(e, randomBytes(32), "c1")).toThrow();
  });

  it("falls back to the minimal fetch payload for a large card", () => {
    // ~2900 bytes: under UnifiedPush's own cap, over the relay's 2800
    const big = card({ body: "B".repeat(2600) });
    const { e, full } = sealCard(big, KEY);
    expect(full).toBe("0");
    expect(JSON.parse(open(e, KEY, "c1"))).toEqual({ type: "card", id: "c1", kind: "intercom", tag: "door", priority: "high", at: "1700000000000", fetch: "1" });
  });

  it("a card UnifiedPush itself had to shrink to a fetch stub is not full either", () => {
    const { e, full } = sealCard(card({ title: "T".repeat(2900), body: "B".repeat(3000) }), KEY);
    expect(full).toBe("0");
    expect(JSON.parse(open(e, KEY, "c1"))).toMatchObject({ id: "c1", fetch: "1" });
  });
});

describe("relayRequests", () => {
  it("an alert carries only the sealed card, never its text", () => {
    const [r, ...rest] = relayRequests(card({ kind: "water", priority: "default" }), { handle: H, key: KEY });
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ handle: H, type: "alert", priority: "normal", critical: false, collapse: "door", kind: "water", data: { v: "1", id: "c1", full: "1", type: "card" } });
    const s = JSON.stringify(r);
    for (const t of ["Sună la ușă", "Interfon principal", "Poarta", "Deschide"]) expect(s).not.toContain(t);
  });

  it("high / urgent map to priority high", () => {
    expect(relayRequests(card({ kind: "water", priority: "urgent" }), { handle: H, key: KEY })[0]?.priority).toBe("high");
  });

  it("a dismiss is a background push", () => {
    const rs = relayRequests(card({ dismissedAt: new Date() }), { handle: H, activityHandle: HA, key: KEY });
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ type: "background", priority: "normal", data: { type: "dismiss" } });
    expect(JSON.parse(open(rs[0]!.data.e, KEY, "c1"))).toMatchObject({ type: "dismiss" });
  });

  it("an intercom ring also starts the Live Activity with sealed state", () => {
    const rs = relayRequests(card(), { handle: H, activityHandle: HA, key: KEY });
    expect(rs.map((r) => r.type)).toEqual(["alert", "liveactivity"]);
    const la = rs[1]!;
    expect(la).toMatchObject({ handle: HA, priority: "high", activity: { event: "start", attributesType: "IntercomAttributes", attributes: { cardId: "c1" }, state: { ringing: true, since: 1_700_000_000 } } });
    expect(JSON.parse(open(la.activity!.state.e, KEY, "c1"))).toEqual({ canOpen: true, door: "Poarta" });
    for (const r of rs) for (const t of ["Sună la ușă", "Interfon principal", "Poarta"]) expect(JSON.stringify(r)).not.toContain(t);
  });

  it("no Live Activity without an activity handle", () => {
    expect(relayRequests(card(), { handle: H, key: KEY }).map((r) => r.type)).toEqual(["alert"]);
  });
});

describe("sendRelay", () => {
  it("returns the handles the relay reports gone and keeps going for the rest", async () => {
    const seen: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gone = await sendRelay(
      [
        { handle: H, activityHandle: HA, key: KEY },
        { handle: `h1.${"c".repeat(40)}`, key: KEY },
      ],
      card(),
      async (b) => {
        seen.push(`${b.type}:${b.handle.slice(3, 4)}`);
        if (b.handle === HA) return { status: 200, gone: true };
        if (b.handle.startsWith("h1.c")) return { status: 429 };
        return { status: 200 };
      },
    );
    expect(gone).toEqual([HA]);
    expect(seen.sort()).toEqual(["alert:a", "alert:c", "liveactivity:b"]);
    expect(warn).toHaveBeenCalledWith("[vmui] push relay", 429, "alert");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("h1.");
    warn.mockRestore();
  });

  it("treats status 410 as gone", async () => {
    expect(await sendRelay([{ handle: H, key: KEY }], card({ kind: "water" }), async () => ({ status: 410 }))).toEqual([H]);
  });
});
