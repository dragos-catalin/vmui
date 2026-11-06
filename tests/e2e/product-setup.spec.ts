import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Product setup surfaces (docs/product PLAN P1/P2): the owner manages the house and the
// integrations from Home → Settings; token routes speak the JSON error contract.
// Runs on the cloud VM (scripts/e2e-cloud): fresh DB, seeded admin session, no Home Assistant.

const session = process.env.PW_SESSION_FILE ? readFileSync(process.env.PW_SESSION_FILE, "utf8").trim() : "";
const base = process.env.PW_BASE_URL ?? "http://127.0.0.1:3737";
const shots = "test-results/product-setup";

async function signedIn(page: Page, locale: "en" | "ro") {
  const url = new URL(base);
  await page.context().addCookies([
    { name: "vmui_session", value: session, domain: url.hostname, path: "/" },
    { name: "vmui_locale", value: locale, domain: url.hostname, path: "/" },
  ]);
  // the audit SSE never idles: do not wait for networkidle
  await page.route("**/api/events", (r) => r.abort());
}

for (const locale of ["en", "ro"] as const) {
 for (const width of [390, 1440] as const) {
  test.describe(`settings (${locale}, ${width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await signedIn(page, locale);
    });

    test("integrations section: HA form, household, test without HA shows an error", async ({ page }) => {
      await page.goto("/home?tab=settings&section=integrations", { waitUntil: "domcontentloaded" });
      const url = page.getByPlaceholder("http://homeassistant.local:8123");
      await expect(url).toBeVisible({ timeout: 30_000 });
      await url.fill("http://127.0.0.1:9");
      await page.getByPlaceholder(locale === "en" ? "Paste a long-lived access token" : "Lipește un token de acces de lungă durată").fill("not-a-real-token");
      await page.getByRole("button", { name: locale === "en" ? "Test connection" : "Testează conexiunea" }).click();
      await expect(page.getByTestId("ha-probe")).toContainText(locale === "en" ? "did not answer" : "nu a răspuns", { timeout: 15_000 });
      await page.screenshot({ path: `${shots}/integrations-${locale}-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test("house section: add a room, it appears, delete it again", async ({ page }) => {
      await page.goto("/home?tab=settings&section=house", { waitUntil: "domcontentloaded" });
      const name = page.getByRole("textbox", { name: locale === "en" ? "Room name" : "Numele camerei" });
      await expect(name).toBeVisible({ timeout: 30_000 });
      await name.fill("Atelier E2E");
      await page.getByRole("button", { name: locale === "en" ? "Add room" : "Adaugă cameră" }).click();
      const row = page.getByRole("button", { name: new RegExp(`${locale === "en" ? "Delete room" : "Șterge camera"}: Atelier E2E`) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `${shots}/house-${locale}-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await row.click();
      await expect(row).toBeHidden({ timeout: 15_000 });
    });

    test("devices card: QR pairing code renders", async ({ page }) => {
      await page.goto("/home?tab=notifications", { waitUntil: "domcontentloaded" });
      const show = page.getByRole("button", { name: locale === "en" ? "Add a device with a QR code" : "Adaugă un dispozitiv cu un cod QR" });
      await expect(show).toBeVisible({ timeout: 30_000 });
      await show.click();
      const qr = page.getByRole("img", { name: locale === "en" ? "QR code to pair a device" : "Cod QR pentru asocierea unui dispozitiv" });
      await expect(qr.locator("svg")).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `${shots}/pair-qr-${locale}-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
 }
}

test("token routes answer the JSON error contract", async ({ request }) => {
  const r = await request.get("/api/display/state", { headers: { authorization: "Bearer vmd_nope", "accept-language": "ro" } });
  expect(r.status()).toBe(403);
  expect(await r.json()).toEqual({ ok: false, code: "forbidden", error: "Nu ai voie" });
});

test("audit SSE refuses an anonymous client", async ({ request }) => {
  const r = await request.get("/api/events", { maxRedirects: 0 });
  expect([307, 401]).toContain(r.status());
});
