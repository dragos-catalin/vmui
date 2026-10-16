import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const rows = new Map<string, Row>();
const sent: Array<{ tokens: string[]; card: Row }> = [];
let fcmFails = false;

vi.mock("drizzle-orm", () => ({
  and: (...c: Array<(r: Row) => boolean>) => (r: Row) => c.every((f) => f(r)),
  eq: (col: string, v: unknown) => (r: Row) => r[col] === v,
  isNull: (col: string) => (r: Row) => r[col] == null,
  desc: () => undefined,
}));
vi.mock("@/lib/db/schema", () => ({
  homeNotifications: { id: "id", tag: "tag", dismissedAt: "dismissedAt", readAt: "readAt", deliveredTo: "deliveredTo", createdAt: "createdAt" },
  pairedDevices: { id: "id", pushToken: "pushToken", language: "language", status: "status" },
  auditLog: {},
}));
vi.mock("@/lib/db", () => {
  const devices: Row[] = [{ id: "d1", pushToken: "tok-1", language: "en", status: "approved" }];
  const table = (t: { id: string; status?: string }) => ("status" in t ? devices : [...rows.values()]);
  return {
    db: {
      select: () => ({
        from: (t: { id: string; status?: string }) => ({
          where: (pred: (r: Row) => boolean) => {
            const out = table(t).filter(pred);
            return Object.assign(Promise.resolve(out), { get: async () => out[0] });
          },
        }),
      }),
      update: () => ({
        set: (v: Row) => ({
          where: async (pred: (r: Row) => boolean) => {
            for (const r of rows.values()) if (pred(r)) Object.assign(r, v);
          },
        }),
      }),
    },
  };
});
vi.mock("@/lib/home/credentials", () => ({ credential: () => undefined }));
vi.mock("@/lib/home/ha-client", () => ({ ha: { callService: async () => undefined } }));
vi.mock("./settings", () => ({ loadNotifySettings: async () => ({ fcm: { enabled: true } }) }));
vi.mock("./fcm", () => ({
  sendFcm: async (tokens: string[], card: Row) => {
    if (fcmFails) throw new Error("fcm down");
    sent.push({ tokens, card });
    return [];
  },
}));

import { dismiss, dismissByTag } from "./index";

const flush = () => new Promise((r) => setTimeout(r, 0));

function card(id: string, tag: string | null): Row {
  const now = new Date();
  return { id, kind: "pc", tag, title: "t", body: "b", subtitle: null, color: null, icon: null, image: null, priority: "default", progress: null, actions: "[]", url: null, data: "{}", sticky: false, expiresAt: null, readAt: null, dismissedAt: null, deliveredTo: null, fallbackAt: null, actedWith: null, actedBy: null, createdAt: now, updatedAt: now };
}

beforeEach(() => {
  rows.clear();
  sent.length = 0;
  fcmFails = false;
});

describe("dismiss → phone", () => {
  it("sends an FCM dismiss carrying the card id and tag", async () => {
    rows.set("a1", card("a1", "pc-agent"));
    const c = await dismiss("a1", "pc");
    await flush();
    expect(c?.dismissedAt).toBeInstanceOf(Date);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tokens).toEqual(["tok-1"]);
    expect(sent[0]?.card).toMatchObject({ id: "a1", tag: "pc-agent" });
    expect(sent[0]?.card.dismissedAt).toBeInstanceOf(Date);
  });

  it("dismissByTag dismisses every open card with the tag and tells the phone for each", async () => {
    rows.set("a1", card("a1", "pc-agent"));
    rows.set("a2", card("a2", "pc-agent"));
    rows.set("b1", card("b1", "water-pace"));
    await dismissByTag("pc-agent", "pc");
    await flush();
    expect(sent.map((s) => s.card.id).sort()).toEqual(["a1", "a2"]);
    expect(rows.get("b1")?.dismissedAt).toBeNull();
  });

  it("an already dismissed card sends nothing", async () => {
    rows.set("a1", { ...card("a1", "pc-agent"), dismissedAt: new Date() });
    await dismiss("a1");
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("fails open when FCM throws", async () => {
    rows.set("a1", card("a1", "pc-agent"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fcmFails = true;
    const c = await dismiss("a1");
    await flush();
    expect(c?.dismissedAt).toBeInstanceOf(Date);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
