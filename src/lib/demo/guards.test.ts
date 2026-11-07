import { afterEach, describe, expect, it, vi } from "vitest";

// Representative destructive action: minting an appliance token is refused on the demo hub
// before any auth or write, and works normally otherwise.

const mint = vi.fn(async () => ({ id: "d1", token: "vmd_x" }));
vi.mock("@/lib/devices/pairing", () => ({ mintApplianceToken: mint }));
vi.mock("@/lib/home/access", () => ({
  HomeAccessError: class extends Error {},
  requireOwner: async () => ({ userId: "u1", email: "o@x", displayName: "O" }),
  journalUserId: () => "u1",
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

afterEach(() => {
  delete process.env.VATRA_DEMO;
  mint.mockClear();
});

describe("demo_readonly guards", () => {
  it("refuses appliance token minting on the demo hub", async () => {
    process.env.VATRA_DEMO = "1";
    const { mintApplianceAction } = await import("@/server/actions/appliances");
    expect(await mintApplianceAction({ profile: "display", name: "x" })).toEqual({ ok: false, error: "demo_readonly" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints normally when not a demo hub", async () => {
    const { mintApplianceAction } = await import("@/server/actions/appliances");
    const { APPLIANCE_PROFILE_IDS } = await import("@/lib/devices/appliance-scopes");
    const r = await mintApplianceAction({ profile: APPLIANCE_PROFILE_IDS[0] ?? "display", name: "x" });
    expect(r.ok).toBe(true);
    expect(mint).toHaveBeenCalledOnce();
  });

  it("route helper answers 403 demo_readonly", async () => {
    process.env.VATRA_DEMO = "1";
    const { demoRefusalResponse } = await import("./mode");
    const res = demoRefusalResponse();
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ ok: false, code: "demo_readonly" });
    delete process.env.VATRA_DEMO;
    expect(demoRefusalResponse()).toBeNull();
  });
});
