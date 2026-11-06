// Channel manifest for vatra-updater (P4-02 / P5-03): which digests a hub on <channel> should run.
//   node scripts/channel-manifest.mjs --channel beta --version 0.4.0 --image ghcr.io/o/vatra@sha256:…
// The companion images (HA, ESPHome, Mosquitto) are pinned in deploy/vatra/pins.json and move only
// when that file changes, so a Vatra release never silently upgrades Home Assistant.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0 || !argv[i + 1]) throw new Error(`--${n} is required`);
  return argv[i + 1];
};
const DIGEST = /@sha256:[0-9a-f]{64}$/;

const channel = opt("channel");
if (!["beta", "stable"].includes(channel)) throw new Error("--channel must be beta|stable");
const version = opt("version");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`bad version ${version}`);
const image = opt("image");
if (!DIGEST.test(image)) throw new Error("--image must be pinned by digest");
const pins = JSON.parse(readFileSync(resolve(here, "../deploy/vatra/pins.json"), "utf8"));
for (const [k, v] of Object.entries(pins.images)) if (!DIGEST.test(v)) throw new Error(`pins.json ${k} is not pinned by digest`);
const { apiVersion, minClient } = (() => {
  const src = readFileSync(resolve(here, "../src/lib/api-version.ts"), "utf8");
  const num = (n) => Number(new RegExp(`${n} = (\\d+)`).exec(src)?.[1]);
  return { apiVersion: num("API_VERSION"), minClient: num("MIN_CLIENT") };
})();

const manifest = {
  schema: 1,
  channel,
  version,
  apiVersion,
  minClient,
  publishedAt: new Date().toISOString(),
  images: { VATRA_IMAGE: image, ...pins.images },
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
