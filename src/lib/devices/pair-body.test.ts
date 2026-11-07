import { describe, expect, it } from "vitest";
import { pairBody } from "./pair-body";

describe("pairing body", () => {
  it("keeps e-mail + password (sign-in pairing is not downgraded to a pending request)", () => {
    const p = pairBody.parse({ name: "Phone", platform: "vatra-android", email: "a@b.ro", password: "x" });
    expect("email" in p && p.password).toBe("x");
  });

  it("keeps the invite", () => {
    expect("invite" in pairBody.parse({ name: "Phone", platform: "vatra-ios", invite: "a".repeat(20) })).toBe(true);
  });

  it("a bare request stays a pending request", () => {
    const p = pairBody.parse({ name: "Phone", platform: "vatra-android" });
    expect("email" in p || "invite" in p).toBe(false);
  });
});