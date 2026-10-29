import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notify/i18n", () => ({ msg: (k: string) => k }));

const { bindingFor } = await import("./pairing");

describe("bindingFor: who a newly approved device acts as", () => {
  it("binds to the approver whenever the approver is a known member", () => {
    expect(bindingFor("vitals-desktop", "member-1", "owner-1")).toBe("member-1");
    expect(bindingFor("android", "member-1", "owner-1")).toBe("member-1");
  });

  it("binds a Vitals app approved through the shared desktop token to the owner, so its Health page can read", () => {
    for (const p of ["vitals-desktop", "vitals-ios", "vitals-android"]) expect(bindingFor(p, null, "owner-1")).toBe("owner-1");
  });

  it("leaves any other device unbound when the approver has no identity", () => {
    expect(bindingFor("android", null, "owner-1")).toBeNull();
    expect(bindingFor("esp32", null, "owner-1")).toBeNull();
  });

  it("leaves a Vitals app unbound when there is no owner to bind to", () => {
    expect(bindingFor("vitals-ios", null, null)).toBeNull();
  });
});
