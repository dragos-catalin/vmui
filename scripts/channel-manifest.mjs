// Channel manifest for vatra-updater (P4-02 / P5-03): which digests a hub on <channel> should run.
//   node scripts/channel-manifest.mjs --channel beta --version 0.4.0 --image ghcr.io/o/vatra@sha256:…
//     [--os-index <dir>/os-index.json --os-base-url https://…/download/v0.4.0/]
// The companion images (HA, ESPHome, Mosquitto) are pinned in deploy/vatra/pins.json and move only
// when that file changes, so a Vatra release never silently upgrades Home Assistant.
// P5-04: os-index.json (written by deploy/vatra/os/bundle.sh) lists the A/B OS bundles; the manifest
// gets `os: {version, platforms: {pi4|pi5|x86: {url, sha256, size, bundleHash}}}` with sha256 + size
// computed here from the bundle files, so the cosign signature over this manifest covers them.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0 || !argv[i + 1]) throw new Error(`--${n} is required`);
  return argv[i + 1];
};
const optional = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return undefined;
  if (!argv[i + 1]) throw new Error(`--${n} needs a value`);
  return argv[i + 1];
};
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const OS_PLATFORMS = ["pi4", "pi5", "x86"];

const channel = opt("channel");
if (!["beta", "stable"].includes(channel)) throw new Error("--channel must be beta|stable");
const version = opt("version");
if (!SEMVER.test(version)) throw new Error(`bad version ${version}`);
const image = opt("image");
if (!DIGEST.test(image)) throw new Error("--image must be pinned by digest");
const pins = JSON.parse(readFileSync(resolve(here, "../deploy/vatra/pins.json"), "utf8"));
for (const [k, v] of Object.entries(pins.images)) if (!DIGEST.test(v)) throw new Error(`pins.json ${k} is not pinned by digest`);
const { apiVersion, minClient } = (() => {
  const src = readFileSync(resolve(here, "../src/lib/api-version.ts"), "utf8");
  const num = (n) => Number(new RegExp(`${n} = (\\d+)`).exec(src)?.[1]);
  return { apiVersion: num("API_VERSION"), minClient: num("MIN_CLIENT") };
})();

function osBlock(indexPath, baseUrl) {
  if (!/^https:\/\/\S+\/$/.test(baseUrl ?? "")) throw new Error("--os-base-url must be an https URL ending in /");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!SEMVER.test(index.version ?? "")) throw new Error(`os-index: bad version ${index.version}`);
  const entries = Object.entries(index.platforms ?? {});
  if (!entries.length) throw new Error("os-index: no platforms");
  const platforms = {};
  for (const [name, p] of entries) {
    if (!OS_PLATFORMS.includes(name)) throw new Error(`os-index: unknown platform ${name}`);
    if (!/^[\w.-]+\.rugixb$/.test(p.file ?? "")) throw new Error(`os-index: ${name}.file must be a bare *.rugixb name`);
    if (!/^(?:[a-z0-9_-]+:)?[0-9a-f]{32,128}$/.test(p.bundleHash ?? "")) throw new Error(`os-index: ${name}.bundleHash is not a Rugix bundle hash`);
    const file = resolve(dirname(indexPath), p.file);
    const bytes = readFileSync(file);
    platforms[name] = {
      url: baseUrl + p.file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: statSync(file).size,
      bundleHash: p.bundleHash,
    };
  }
  return { version: index.version, platforms };
}

const osIndex = optional("os-index");
const manifest = {
  schema: 1,
  channel,
  version,
  apiVersion,
  minClient,
  publishedAt: new Date().toISOString(),
  images: { VATRA_IMAGE: image, ...pins.images },
  ...(osIndex ? { os: osBlock(osIndex, optional("os-base-url")) } : {}),
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
