import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Self-service account deletion (P11-01): members erase themselves, the owner and the last admin cannot.

let D: typeof import("./delete");
let C: typeof import("@/lib/ai/consent");
let db: typeof import("@/lib/db").db;
let S: typeof import("@/lib/db/schema");

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-del-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  ({ db } = await import("@/lib/db"));
  S = await import("@/lib/db/schema");
  D = await import("./delete");
  C = await import("@/lib/ai/consent");
  const u = (id: string, role: "admin" | "viewer") => ({ id, email: `${id}@x.test`, displayName: id, passwordHash: "scrypt$00$00", role });
  await db.insert(S.users).values([u("owner", "admin"), u("kid", "viewer"), u("admin2", "admin"), u("solo", "admin")]);
  await db.insert(S.homeMembers).values([
    { userId: "owner", role: "owner", rooms: "{}" },
    { userId: "kid", role: "child", rooms: "{}" },
    { userId: "admin2", role: "adult", rooms: "{}" },
  ]);
});

describe("deletionRefusal", () => {
  it("refuses the household owner", async () => {
    expect(await D.deletionRefusal("owner")).toBe("owner");
  });
  it("treats an admin without a member row as owner", async () => {
    expect(await D.deletionRefusal("solo")).toBe("owner");
  });
  it("lets a member and a non-last admin go", async () => {
    expect(await D.deletionRefusal("kid")).toBeNull();
    expect(await D.deletionRefusal("admin2")).toBeNull();
  });
  it("reports unknown accounts", async () => {
    expect(await D.deletionRefusal("ghost")).toBe("notFound");
  });
});

describe("eraseAccount", () => {
  it("removes personal data, revokes devices and keeps an audit line", async () => {
    await db.insert(S.meals).values({ id: "m1", at: new Date(), day: "2026-11-07", name: "soup", mealType: "lunch", calories: 300, userId: "kid" });
    await db.insert(S.hydration).values({ id: "h1", at: new Date(), day: "2026-11-07", ml: 250, userId: "kid" });
    await db.insert(S.pairedDevices).values({ id: "d1", name: "phone", platform: "android", tokenHash: "x", status: "approved", userId: "kid", pushToken: "tok", pushKey: "k" });
    await db.insert(S.sessions).values({ id: "s1", userId: "kid", expiresAt: new Date(Date.now() + 1e6) });
    await C.setAiConsent("kid", true);

    await D.eraseAccount("kid");

    expect(await db.select().from(S.users).where((await import("drizzle-orm")).eq(S.users.id, "kid"))).toEqual([]);
    expect(await db.select().from(S.meals)).toEqual([]);
    expect(await db.select().from(S.hydration)).toEqual([]);
    expect(await db.select().from(S.sessions)).toEqual([]);
    expect(db.select().from(S.homeMembers).all().map((m) => m.userId).sort()).toEqual(["admin2", "owner"]);
    const [dev] = await db.select().from(S.pairedDevices);
    expect(dev).toMatchObject({ status: "revoked", userId: null, pushToken: null, pushKey: null });
    expect(await C.getAiConsent("kid")).toBeNull();
    const audit = await db.select().from(S.auditLog);
    expect(audit.some((a) => a.action === "auth.account.delete" && a.target === "kid" && a.status === "ok")).toBe(true);
  });
});

describe("AI consent", () => {
  it("is off until granted and off again when revoked", async () => {
    expect(await C.hasAiConsent("owner")).toBe(false);
    await C.setAiConsent("owner", true);
    expect(await C.hasAiConsent("owner")).toBe(true);
    await C.setAiConsent("owner", false);
    expect(await C.hasAiConsent("owner")).toBe(false);
  });
});
