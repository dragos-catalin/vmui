import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Devices → Add (P6-04): firmware served by the hub, the ESP Web Tools install button, mDNS scan
// and the manual adopt form with its LAN guard. Cloud VM only (scripts/e2e-cloud): `next start`
// runs from the work dir, so a firmware-dist written here is what /api/firmware serves.

const session = process.env.PW_SESSION_FILE ? readFileSync(process.env.PW_SESSION_FILE, "utf8").trim() : "";
const base = process.env.PW_BASE_URL ?? "http://127.0.0.1:3737";
const shots = "test-results/add-device";
const ID = "vatra-display-s3";
const V = "9.9.9-e2e";
const L = {
  en: { title: "Add a Vatra device", install: "Install on Display, 4\" touch (ESP32-S3)", board: "Display, 4\" touch (ESP32-S3)", adopt: "Adopt", badHost: "Use the board's local address", none: "No boards found yet", nav: "Add device" },
  ro: { title: "Adaugă un dispozitiv Vatra", install: "Instalează pe Ecran tactil 4\" (ESP32-S3)", board: "Ecran tactil 4\" (ESP32-S3)", adopt: "Preia", badHost: "Folosește adresa locală a plăcii", none: "Nicio placă găsită încă", nav: "Adaugă dispozitiv" },
} as const;

test.beforeAll(() => {
  const dir = join("firmware-dist", ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID}-${V}.factory.bin`), Buffer.alloc(4096, 1));
  writeFileSync(join(dir, `${ID}-${V}.ota.bin`), Buffer.alloc(2048, 2));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name: "Vatra Display (4\" touch)", version: V, builds: [{ chipFamily: "ESP32-S3", parts: [{ path: `${ID}-${V}.factory.bin`, offset: 0 }], ota: { path: `${ID}-${V}.ota.bin`, md5: "0123456789abcdef0123456789abcdef" } }], vatra: { id: ID, project: "vatra.display" } }),
  );
  writeFileSync(join(dir, "secret.txt"), "never served");
});

async function signedIn(page: Page, locale: "en" | "ro") {
  const url = new URL(base);
  await page.context().addCookies([
    { name: "vmui_session", value: session, domain: url.hostname, path: "/" },
    { name: "vmui_locale", value: locale, domain: url.hostname, path: "/" },
  ]);
  await page.route("**/api/events", (r) => r.abort());
  await page.route("**/api/home/events**", (r) => r.abort());
}

test("firmware endpoints: public manifest/version/md5/bins, nothing the manifest does not name", async ({ request }) => {
  const list = await request.get("/api/firmware");
  expect(list.status()).toBe(200);
  expect(((await list.json()) as { images: Array<{ id: string }> }).images.map((i) => i.id)).toContain(ID);
  const man = await request.get(`/api/firmware/${ID}/manifest.json`);
  expect(man.status()).toBe(200);
  expect(((await man.json()) as { version: string }).version).toBe(V);
  expect(await (await request.get(`/api/firmware/${ID}/version`)).text()).toBe(V);
  expect(await (await request.get(`/api/firmware/${ID}/ota.md5`)).text()).toBe("0123456789abcdef0123456789abcdef");
  const ota = await request.get(`/api/firmware/${ID}/ota.bin`);
  expect(ota.status()).toBe(200);
  expect(ota.headers()["content-length"]).toBe("2048");
  expect((await request.get(`/api/firmware/${ID}/${ID}-${V}.factory.bin`)).status()).toBe(200);
  expect((await request.get(`/api/firmware/${ID}/secret.txt`)).status()).toBe(404);
  expect((await request.get(`/api/firmware/${ID}/..%2F..%2Fpackage.json`)).status()).toBe(404);
  expect((await request.get("/api/firmware/vatra-nope/manifest.json")).status()).toBe(404);
});

test("S3 summary needs a device credential", async ({ request }) => {
  const r = await request.get("/api/esp/display/vatra-display-s3-abc/summary");
  expect(r.status()).toBe(403);
});

for (const locale of ["en", "ro"] as const) {
  for (const width of [390, 1440] as const) {
    test(`settings > add device (${locale}, ${width}px)`, async ({ page }) => {
      const t = L[locale];
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await signedIn(page, locale);
      await page.goto("/home?tab=settings&section=addDevice", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: t.title })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: t.nav })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("radio", { name: new RegExp(t.board.replace(/[()"]/g, ".")) })).toBeChecked();
      // headless Chromium on http://127.0.0.1 is a secure context with Web Serial: the real ESP Web Tools button renders
      await expect(page.getByRole("button", { name: t.install })).toBeVisible();
      await expect(page.locator("esp-web-install-button")).toHaveAttribute("manifest", `/api/firmware/${ID}/manifest.json`);
      await expect(page.getByText(t.none)).toBeVisible({ timeout: 15_000 });
      // the LAN guard refuses a public host before any request leaves the hub
      await page.getByRole("textbox").last().fill("8.8.8.8");
      await page.getByRole("button", { name: t.adopt, exact: true }).click();
      await expect(page.getByText(t.badHost)).toBeVisible({ timeout: 15_000 });
      const axe = await new AxeBuilder({ page }).include("#add-device").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      await page.screenshot({ path: `${shots}/add-${locale}-${width}.png`, fullPage: true });
    });
  }
}
