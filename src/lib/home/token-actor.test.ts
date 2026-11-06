import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Token-authenticated routes used to treat ANY approved device token as the owner.
// tokenActor must resolve a device to the member it is bound to, and refuse unbound ones.

vi.mock("@/lib/auth", () => ({ authEnabled: async () => true, getCurrentUser: async () => null }));

type Access = typeof import("./access");
let A: Access;

const tok = (t: string) => new Request("http://hub/api/lights", { headers: { authorization: `Bearer ${t}` } });
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

beforeAll(async () => {
  process.env.VMUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "vatra-actor-")), "t.db");
  (globalThis as { __vmui_sqlite__?: unknown }).__vmui_sqlite__ = undefined;
  const { db } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const now = new Date();
  const user = (id: string, role: "admin" | "viewer") => ({ id, email: `${id}@x.ro`, displayName: id, passwordHash: "x", role, createdAt: now });
  await db.insert(s.users).values([user("owner", "admin"), user("kid", "viewer")]);
  await db.insert(s.homeMembers).values([
    { userId: "owner", role: "owner", rooms: "{}", createdAt: now },
    { userId: "kid", role: "child", rooms: JSON.stringify({ bedroom: "control", kitchen: "view" }), createdAt: now },
  ] as never);
  const dev = (id: string, token: string, userId: string | null) => ({ id, name: id, platform: "android", tokenHash: sha(token), status: "approved", userId, createdAt: now });
  await db.insert(s.pairedDevices).values([dev("d-owner", "vmd_owner", "owner"), dev("d-kid", "vmd_kid", "kid"), dev("d-free", "vmd_free", null)] as never);
  A = await import("./access");
});

describe("tokenActor", () => {
  it("binds a device token to its member", async () => {
    const kid = await A.tokenActor(tok("vmd_kid"));
    expect(kid?.role).toBe("child");
    expect(kid?.deviceId).toBe("d-kid");
  });

  it("refuses an approved but unbound device (it used to get owner rights)", async () => {
    expect(await A.tokenActor(tok("vmd_free"))).toBeNull();
  });

  it("refuses an unknown device token instead of falling back to the owner", async () => {
    expect(await A.tokenActor(tok("vmd_nope"))).toBeNull();
  });

  it("maps the shared house token (no device token) to the owner", async () => {
    const a = await A.tokenActor(new Request("http://hub/api/lights?k=shared"));
    expect(a?.role).toBe("owner");
  });
});

describe("room checks for device actors", () => {
  it("child controls only granted rooms", async () => {
    const kid = (await A.tokenActor(tok("vmd_kid")))!;
    const bedroomLight = [...A.visibleEntities(kid)].find((e) => A.roomOfEntity(e) === "bedroom");
    const kitchenEntity = [...A.visibleEntities(kid)].find((e) => A.roomOfEntity(e) === "kitchen");
    expect(bedroomLight && A.canControlEntity(kid, bedroomLight)).toBe(true);
    expect(kitchenEntity && A.canControlEntity(kid, kitchenEntity)).toBe(false);
    expect(A.visibleRooms(kid)).not.toContain("office");
  });

  it("PC/Pi control is owner-only", async () => {
    expect(await A.ownerTokenAuthorized(tok("vmd_owner"))).toBe(true);
    expect(await A.ownerTokenAuthorized(tok("vmd_kid"))).toBe(false);
    expect(await A.ownerTokenAuthorized(tok("vmd_free"))).toBe(false);
  });
});
