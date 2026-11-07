import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apnsRequests, providerToken, sendApns, type ApnsRequest } from "./apns";
import type { LocalizedCard } from "./index";

const card = (over: Partial<LocalizedCard> = {}): LocalizedCard =>
  ({
    id: "c1",
    kind: "intercom",
    tag: "door",
    title: "Sună la ușă",
    body: "Interfon",
    subtitle: "Poarta",
    color: "#ff8800",
    icon: "door",
    image: null,
    priority: "high",
    progress: null,
    actions: [{ id: "open", label: "Deschide", style: "primary", body: { secret: "x" } }],
    url: null,
    sticky: false,
    dismissedAt: null,
    updatedAt: new Date(1_700_000_000_000),
    ...over,
  }) as unknown as LocalizedCard;

const TOKEN = "a".repeat(64);
const ACT = "b".repeat(64);

describe("APNs payload", () => {
  it("is a visible, mutable alert carrying the shared card shape without action bodies", () => {
    const [r, ...rest] = apnsRequests(card({ kind: "water", priority: "default" }), { token: TOKEN, sandbox: false }, "ro.vatra.app");
    expect(rest).toEqual([]);
    expect(r?.headers).toMatchObject({ "apns-push-type": "alert", "apns-priority": "10", "apns-topic": "ro.vatra.app", "apns-collapse-id": "door" });
    const aps = r?.payload.aps as Record<string, unknown>;
    expect(aps).toMatchObject({ "mutable-content": 1, category: "vatra.water", "interruption-level": "active", alert: { title: "Sună la ușă", subtitle: "Poarta", body: "Interfon" } });
    expect("sound" in aps).toBe(false);
    const v = r?.payload.vatra as Record<string, string>;
    expect(v).toMatchObject({ type: "card", id: "c1", kind: "water", tag: "door", priority: "default" });
    expect(JSON.stringify(r?.payload)).not.toContain("secret");
  });

  it("rings the intercom as time-sensitive and starts the Live Activity when the phone gave a token", () => {
    const reqs = apnsRequests(card(), { token: TOKEN, sandbox: true, activityToken: ACT }, "ro.vatra.app");
    expect(reqs).toHaveLength(2);
    expect((reqs[0]?.payload.aps as Record<string, unknown>)["interruption-level"]).toBe("time-sensitive");
    const la = reqs[1] as ApnsRequest;
    expect(la.token).toBe(ACT);
    expect(la.sandbox).toBe(true);
    expect(la.headers).toMatchObject({ "apns-push-type": "liveactivity", "apns-topic": "ro.vatra.app.push-type.liveactivity" });
    expect(la.payload.aps).toMatchObject({ event: "start", "attributes-type": "IntercomAttributes", attributes: { cardId: "c1" }, "content-state": { ringing: true, canOpen: true } });
    // no activity token, or not a ring: no Live Activity
    expect(apnsRequests(card(), { token: TOKEN, sandbox: false }, "x")).toHaveLength(1);
    expect(apnsRequests(card({ priority: "default" }), { token: TOKEN, sandbox: false, activityToken: ACT }, "x")).toHaveLength(1);
  });

  it("a dismissed card becomes a silent background push", () => {
    const [r] = apnsRequests(card({ dismissedAt: new Date() } as Partial<LocalizedCard>), { token: TOKEN, sandbox: false }, "ro.vatra.app");
    expect(r?.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5" });
    expect(r?.payload).toMatchObject({ aps: { "content-available": 1 }, vatra: { type: "dismiss", id: "c1" } });
  });
});

describe("APNs delivery", () => {
  it("signs an ES256 provider token Apple can verify with the key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const t = providerToken({ key: privateKey, keyId: "ABC123DEFG", teamId: "S6D533QSV2" }, 1_800_000_000);
    const [h, c, s] = t.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ iss: "S6D533QSV2", iat: 1_800_000_000 });
    const ok = createVerify("SHA256").update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });

  it("reports device tokens Apple says are gone, ignores malformed ones and keeps the device when only the activity died", async () => {
    const seen: ApnsRequest[] = [];
    const send = async (r: ApnsRequest) => {
      seen.push(r);
      if (r.token === "c".repeat(64)) return { status: 410, reason: "Unregistered" };
      if (r.token === ACT) return { status: 410, reason: "ExpiredToken" };
      return { status: 200 };
    };
    const gone = await sendApns(
      [{ token: TOKEN, sandbox: false, activityToken: ACT }, { token: "c".repeat(64), sandbox: false }, { token: "not-hex", sandbox: false }],
      card(),
      send,
    );
    expect(gone).toEqual(["c".repeat(64)]);
    expect(seen.map((r) => r.token)).toEqual([TOKEN, "c".repeat(64), ACT]);
  });

  it("does nothing when the hub has no way to reach Apple", async () => {
    expect(await sendApns([{ token: TOKEN, sandbox: false }], card(), null)).toEqual([]);
  });
});
