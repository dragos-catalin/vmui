import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Whole-hub backup (P5-06): Settings → Data card downloads an encrypted .vatrabk; the restore
// side refuses a wrong passphrase. Cloud VM only (scripts/e2e-cloud): fresh DB, seeded admin.

const session = process.env.PW_SESSION_FILE ? readFileSync(process.env.PW_SESSION_FILE, "utf8").trim() : "";
const base = process.env.PW_BASE_URL ?? "http://127.0.0.1:3737";
const shots = "test-results/hub-backup";
const L = {
  en: { create: "Download backup", restore: "Restore and restart", pick: "Choose file", wrong: "Wrong passphrase", title: "Whole-hub backup" },
  ro: { create: "Descarcă copia", restore: "Restaurează și repornește", pick: "Alege fișierul", wrong: "Frază de acces greșită", title: "Copie completă a hubului" },
} as const;

async function signedIn(page: Page, locale: "en" | "ro") {
  const url = new URL(base);
  await page.context().addCookies([
    { name: "vmui_session", value: session, domain: url.hostname, path: "/" },
    { name: "vmui_locale", value: locale, domain: url.hostname, path: "/" },
  ]);
  await page.route("**/api/events", (r) => r.abort());
}

for (const locale of ["en", "ro"] as const) {
  for (const width of [390, 1440] as const) {
    test(`settings data: backup download + wrong passphrase refused (${locale}, ${width}px)`, async ({ page }) => {
      const t = L[locale];
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await signedIn(page, locale);
      await page.goto("/settings?section=data", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: t.title })).toBeVisible({ timeout: 30_000 });
      const create = page.getByRole("button", { name: t.create });
      await expect(create).toBeDisabled();
      const pass = page.locator("input[autocomplete=new-password]").first();
      await expect(async () => {
        await pass.fill("long enough passphrase");
        await expect(create).toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      const [download] = await Promise.all([page.waitForEvent("download"), create.click()]);
      expect(download.suggestedFilename()).toMatch(/\.vatrabk$/);
      const file = await download.path();
      expect(readFileSync(file).subarray(0, 8).toString()).toBe("VATRABK1");

      // restore the same file with a wrong passphrase: refused, nothing restarts
      page.on("dialog", (d) => void d.accept());
      await page.locator("input[type=file][accept*=vatrabk]").setInputFiles(file);
      await page.locator("input[autocomplete=off]").last().fill("not the passphrase");
      await page.getByRole("button", { name: t.restore }).click();
      await expect(page.getByText(t.wrong)).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `${shots}/data-${locale}-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
}

test("fresh-hub restore page redirects once the hub is claimed", async ({ page }) => {
  await signedIn(page, "en");
  await page.goto("/setup/restore");
  await expect(page).toHaveURL(/\/settings/);
});
