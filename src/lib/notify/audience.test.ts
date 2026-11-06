import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/household", () => ({ household: () => ({ ownerNotifyService: "", ownerPhone: "" }) }));

import { NOTIFY_KINDS, visibleToRole } from "./index";

// Every member used to receive every card (Copilot runs, PC/Pi health, contact
// form, pairing codes). Only household kinds may reach non-owners.
describe("visibleToRole", () => {
  it("owner sees every kind", () => {
    for (const k of NOTIFY_KINDS) expect(visibleToRole(k, "owner")).toBe(true);
  });

  it("guests and children never see owner-only kinds", () => {
    for (const k of ["copilot", "agents", "pairing", "pc", "pi", "contact", "system"]) {
      expect(visibleToRole(k, "guest")).toBe(false);
      expect(visibleToRole(k, "child")).toBe(false);
      expect(visibleToRole(k, "adult")).toBe(false);
    }
  });

  it("household kinds reach everyone", () => {
    for (const k of ["intercom", "door", "window"]) expect(visibleToRole(k, "guest")).toBe(true);
  });

  it("unknown kinds default to owner-only", () => {
    expect(visibleToRole("something_new", "adult")).toBe(false);
  });
});
