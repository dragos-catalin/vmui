import { describe, expect, it } from "vitest";
import { apiText, requestLocale } from "./api-error";

const req = (h: Record<string, string>) => new Request("http://hub/api/x", { headers: h });

describe("API error locale", () => {
  it("x-vatra-locale beats the cookie, the cookie beats Accept-Language", () => {
    expect(requestLocale(req({ "x-vatra-locale": "en", cookie: "vmui_locale=ro", "accept-language": "ro" }))).toBe("en");
    expect(requestLocale(req({ cookie: "a=1; vmui_locale=ro; b=2", "accept-language": "en-US" }))).toBe("ro");
    expect(requestLocale(req({ cookie: "vmui_locale=xx", "accept-language": "ro-RO" }))).toBe("ro");
    expect(requestLocale(req({}))).toBe("en");
  });

  it("speaks the browser's UI language", () => {
    expect(apiText(req({ cookie: "vmui_locale=ro" }), "backup_passphrase")).toMatch(/greșit/);
  });
});
