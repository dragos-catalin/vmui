// Vatra exports: every raster/vector asset generated from brand/scripts/mark.mjs.
// node brand/scripts/export.mjs            (uses @playwright/test chromium, already a devDependency)
// Writes brand/dist/** and copies into the consumers (public/, src/app/, apps/desktop/src-tauri/icons/).
import { chromium } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { svg, oklchToHex, COLOURWAYS, geometry } from "./mark.mjs";

const D = "brand/dist";
const opt = (px) => (px <= 20 ? "micro" : px <= 48 ? "small" : "master");
const out = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };

// ---------- vector masters ----------
const vectors = {
  "logo/vatra-mark-dark.svg": svg({ size: "master", way: "dark", px: 512 }),
  "logo/vatra-mark-light.svg": svg({ size: "master", way: "light", px: 512 }),
  "logo/vatra-mark-mono-white.svg": svg({ size: "master", way: "monoWhite", px: 512 }),
  "logo/vatra-mark-mono-black.svg": svg({ size: "master", way: "monoBlack", px: 512 }),
  "logo/vatra-mark-small.svg": svg({ size: "small", way: "dark", px: 48 }),
  "logo/vatra-mark-micro.svg": svg({ size: "micro", way: "dark", px: 16 }),
  "logo/vatra-app-icon.svg": svg({ size: "master", way: "dark", tile: true, px: 512 }),
};
// Favicon SVG: micro geometry on a dark tile, switches to the light tile in light browser chrome.
const favDark = svg({ size: "small", way: "dark", tile: true, pad: 3, px: 32 });
const favLight = svg({ size: "small", way: "light", tile: true, pad: 3, px: 32 });
const inner = (s) => s.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
vectors["web/favicon.svg"] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><style>.l{display:none}@media (prefers-color-scheme: light){.d{display:none}.l{display:inline}}</style><g class="d">${inner(favDark)}</g><g class="l">${inner(favLight)}</g></svg>`;
// Monochrome badge for Android push notifications (white on transparent, micro geometry).
vectors["web/badge-mono.svg"] = svg({ size: "micro", way: "monoWhite", px: 96 });
for (const [p, s] of Object.entries(vectors)) out(join(D, p), s);

// ---------- wordmark (lettered: Inter Tight Bold, -4.5% tracking, a with flat terminal, t crossbar cut) ----------
// The lettering is outlined at build time from the system browser's Inter Tight if present; the SVG
// keeps live text with an explicit font stack as the fallback master. Lockups place the mark at 1.15x cap height.
const word = (fill, mark) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 72" width="600" height="144">
  ${mark ? `<g transform="translate(0 4) scale(1.333)">${inner(svg({ size: "master", way: mark, px: 48 }))}</g>` : ""}
  <text x="${mark ? 74 : 2}" y="51" font-family="Inter Tight, Inter, Segoe UI, system-ui, sans-serif" font-weight="700" font-size="46" letter-spacing="-2" fill="${fill}">Vatra</text>
</svg>`;
out(join(D, "logo/vatra-lockup-dark.svg"), word(oklchToHex(...COLOURWAYS.dark.line), "dark"));
out(join(D, "logo/vatra-lockup-light.svg"), word(oklchToHex(...COLOURWAYS.light.line), "light"));
out(join(D, "logo/vatra-wordmark-dark.svg"), word(oklchToHex(...COLOURWAYS.dark.line)));
out(join(D, "logo/vatra-wordmark-light.svg"), word(oklchToHex(...COLOURWAYS.light.line)));

// ---------- construction sheet ----------
const g = geometry("master");
out(join(D, "logo/construction.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="960" height="960"><rect width="48" height="48" fill="#17110d"/>
${Array.from({ length: 49 }, (_, i) => `<path d="M${i} 0V48M0 ${i}H48" stroke="#fff" stroke-opacity="${i % 6 ? 0.05 : 0.15}" stroke-width=".06"/>`).join("")}
<circle cx="24" cy="24" r="20" fill="none" stroke="#5af" stroke-opacity=".4" stroke-width=".1"/><path d="M24 0V48" stroke="#f80" stroke-opacity=".4" stroke-width=".1"/>
<path d="${g.roof}" fill="none" stroke="#f3ece3" stroke-opacity=".8" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
<path d="${g.walls}" fill="none" stroke="#f3ece3" stroke-opacity=".8" stroke-width="${g.stroke}" stroke-linecap="round"/>
<path d="${g.flame}" fill="#e0682a"/><path d="${g.core}" fill="#ffd28a"/>${g.puffs.map((p) => `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="#f3ece3"/>`).join("")}
<path d="${g.roof}" fill="none" stroke="#0ff" stroke-width=".1"/><path d="${g.walls}" fill="none" stroke="#0ff" stroke-width=".1"/></svg>`);

// ---------- raster plan ----------
// [path, px, svg-string]
const R = [];
const tile = (px, way = "dark", extra = {}) => svg({ size: opt(px), way, tile: true, px, pad: px <= 32 ? 3 : 5, ...extra });
// web / PWA
R.push(["web/favicon-32.png", 32, tile(32)], ["web/favicon-16.png", 16, tile(16)], ["web/favicon-48.png", 48, tile(48)]);
R.push(["web/apple-touch-icon.png", 180, svg({ size: "master", way: "dark", tile: true, pad: 6, px: 180 }).replace(/rx="10.5"/, 'rx="0"')]);
R.push(["web/icon-192.png", 192, tile(192)], ["web/icon-512.png", 512, tile(512)]);
// maskable: full-bleed background, mark inside the 80 % safe zone (pad 9.6 of 48 ~ 40 % radius)
const maskable = (px) => svg({ size: "master", way: "dark", tile: true, pad: 11, px }).replace(/rx="10.5"/, 'rx="0"');
R.push(["web/icon-maskable-192.png", 192, maskable(192)], ["web/icon-maskable-512.png", 512, maskable(512)]);
R.push(["web/badge-96.png", 96, vectors["web/badge-mono.svg"]], ["web/shortcut-home-96.png", 96, tile(96)]);
// Tauri / Windows
for (const px of [16, 20, 24, 32, 40, 48, 64, 128, 256]) R.push([`tauri/ico-${px}.png`, px, tile(px)]);
R.push(["tauri/32x32.png", 32, tile(32)], ["tauri/64x64.png", 64, tile(64)], ["tauri/128x128.png", 128, tile(128)], ["tauri/128x128@2x.png", 256, tile(256)], ["tauri/icon.png", 512, tile(512)], ["tauri/icon-32.png", 32, tile(32)]);
for (const [n, px] of [["Square30x30Logo", 30], ["Square44x44Logo", 44], ["Square71x71Logo", 71], ["Square89x89Logo", 89], ["Square107x107Logo", 107], ["Square142x142Logo", 142], ["Square150x150Logo", 150], ["Square284x284Logo", 284], ["Square310x310Logo", 310], ["StoreLogo", 50]])
  R.push([`tauri/${n}.png`, px, tile(px)]);
// Tray: bare mark (no tile), state badge, for dark + light taskbars, at every DPI step.
for (const state of ["ok", "warn", "down", "active"])
  for (const theme of ["dark", "light"])
    for (const px of [16, 20, 24, 32, 40, 48])
      R.push([`tray/tray-${state}-${theme}-${px}.png`, px, svg({ size: opt(px), way: theme, state: state === "ok" ? null : state, px })]);
// OG image 1200x630
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
<defs><radialGradient id="g" cx=".82" cy="-.1" r=".9"><stop offset="0" stop-color="${oklchToHex(0.42, 0.12, 48)}" stop-opacity=".75"/><stop offset="1" stop-color="${oklchToHex(0.155, 0.014, 55)}" stop-opacity="0"/></radialGradient>
<radialGradient id="h" cx="0" cy="1.1" r=".8"><stop offset="0" stop-color="${oklchToHex(0.34, 0.08, 262)}" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="${oklchToHex(0.155, 0.014, 55)}"/><rect width="1200" height="630" fill="url(#g)"/><rect width="1200" height="630" fill="url(#h)"/>
<g transform="translate(96 150) scale(5.2)">${inner(svg({ size: "master", way: "dark", px: 48 }))}</g>
<text x="390" y="310" font-family="Inter Tight, Inter, Segoe UI, system-ui" font-weight="700" font-size="128" letter-spacing="-5" fill="${oklchToHex(0.95, 0.014, 70)}">Vatra</text>
<text x="396" y="380" font-family="Inter, Segoe UI, system-ui" font-weight="500" font-size="38" fill="${oklchToHex(0.76, 0.02, 65)}">home &amp; machines · casă și mașini</text>
</svg>`;
out(join(D, "web/og.svg"), og);
R.push(["web/og-1200x630.png", 0, og]);

// ---------- render ----------
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const pngs = {};
for (const [p, px, s] of R) {
  const w = px || 1200, h = px || 630;
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${s.replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  out(join(D, p), buf);
  pngs[p] = buf;
}
await browser.close();

// ---------- ICO (PNG-compressed entries, Vista+) ----------
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(([px, buf], i) => {
    const o = 6 + i * 16;
    head.writeUInt8(px >= 256 ? 0 : px, o); head.writeUInt8(px >= 256 ? 0 : px, o + 1);
    head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(buf.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...entries.map(([, b]) => b)]);
}
out(join(D, "web/favicon.ico"), ico([[16, pngs["web/favicon-16.png"]], [32, pngs["web/favicon-32.png"]], [48, pngs["web/favicon-48.png"]]]));
out(join(D, "tauri/icon.ico"), ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((px) => [px, pngs[`tauri/ico-${px}.png`]])));
for (const state of ["ok", "warn", "down", "active"])
  for (const theme of ["dark", "light"])
    out(join(D, `tray/tray-${state}-${theme}.ico`), ico([16, 20, 24, 32, 40, 48].map((px) => [px, pngs[`tray/tray-${state}-${theme}-${px}.png`]])));

// ---------- consumers ----------
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(D, from), to); };
// web (Next app icon conventions + public/icons for the manifest)
copy("web/favicon.ico", "src/app/favicon.ico");
copy("web/favicon.svg", "src/app/icon.svg");
copy("web/apple-touch-icon.png", "src/app/apple-icon.png");
copy("web/og-1200x630.png", "src/app/opengraph-image.png");
for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png", "badge-96.png", "shortcut-home-96.png"]) copy(`web/${f}`, `public/icons/${f}`);
copy("logo/vatra-mark-dark.svg", "public/brand/vatra-mark-dark.svg");
copy("logo/vatra-mark-light.svg", "public/brand/vatra-mark-light.svg");
// desktop
const T = "apps/desktop/src-tauri/icons";
for (const f of ["icon.ico", "icon.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon-32.png", "Square30x30Logo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square89x89Logo.png", "Square107x107Logo.png", "Square142x142Logo.png", "Square150x150Logo.png", "Square284x284Logo.png", "Square310x310Logo.png", "StoreLogo.png"]) copy(`tauri/${f}`, `${T}/${f}`);
for (const state of ["ok", "warn", "down", "active"]) for (const theme of ["dark", "light"]) copy(`tray/tray-${state}-${theme}-32.png`, `${T}/tray/tray-${state}-${theme}-32.png`);
copy("logo/vatra-mark-dark.svg", "apps/desktop/public/vatra-mark.svg");

console.log(`exported ${R.length} rasters + ${Object.keys(vectors).length + 5} vectors + ${2 + 8} ico`);
JSON.parse(readFileSync("brand/contrast-pairs.json", "utf8"));
