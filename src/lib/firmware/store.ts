import "server-only";

import { env } from "@/lib/env";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// ESP32 product firmware the hub serves (P6-03): firmware/build.sh output, one folder per image
// with manifest.json (ESP Web Tools format + `vatra` block), the factory/ota bins and the ota md5.
// Looked up in VATRA_FIRMWARE_DIR when set (and only there), else <data dir>/firmware, then ./firmware-dist.

export const IMAGE_ID = /^vatra-[a-z0-9-]{1,40}$/;
const FILE = /^[A-Za-z0-9._+-]{1,120}$/;

const manifestSchema = z.object({
  name: z.string(),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$/),
  builds: z
    .array(
      z.object({
        chipFamily: z.string(),
        parts: z.array(z.object({ path: z.string().regex(FILE), offset: z.number() })).min(1),
        ota: z.object({ path: z.string().regex(FILE), md5: z.string().regex(/^[0-9a-f]{32}$/), summary: z.string().optional() }).optional(),
      }),
    )
    .min(1),
  vatra: z.object({ id: z.string().regex(IMAGE_ID), project: z.string() }).optional(),
});
export type FirmwareManifest = z.infer<typeof manifestSchema>;

export type FirmwareImage = { id: string; name: string; version: string; chipFamily: string; project: string; kind: "display" | "button" | "other" };

export function firmwareRoots(): string[] {
  const explicit = process.env.VATRA_FIRMWARE_DIR;
  const roots = explicit ? [explicit] : [join(dirname(resolve(env.VMUI_DB_PATH)), "firmware"), resolve(process.cwd(), "firmware-dist")];
  return roots.filter((r) => existsSync(r));
}

const cache = new Map<string, { mtime: number; manifest: FirmwareManifest; dir: string }>();

/** The image folder and its validated manifest, or null when unknown or malformed. */
export function loadImage(id: string): { dir: string; manifest: FirmwareManifest } | null {
  if (!IMAGE_ID.test(id)) return null;
  for (const root of firmwareRoots()) {
    const dir = join(root, id);
    const file = join(dir, "manifest.json");
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit;
    try {
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      const v = { mtime, manifest, dir };
      cache.set(file, v);
      return v;
    } catch {
      return null;
    }
  }
  return null;
}

export const kindOf = (id: string): FirmwareImage["kind"] => (id.startsWith("vatra-display-") ? "display" : id.startsWith("vatra-button-") ? "button" : "other");

export function listImages(): FirmwareImage[] {
  const ids = new Set<string>();
  for (const root of firmwareRoots()) {
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && IMAGE_ID.test(d.name)) ids.add(d.name);
  }
  return [...ids]
    .sort()
    .flatMap((id) => {
      const img = loadImage(id);
      if (!img) return [];
      const b = img.manifest.builds[0];
      return b ? [{ id, name: img.manifest.name, version: img.manifest.version, chipFamily: b.chipFamily, project: img.manifest.vatra?.project ?? "", kind: kindOf(id) }] : [];
    });
}

/** Only files the manifest names can be served; no path from the URL reaches the filesystem. */
export function imageFile(id: string, name: string): { path: string; type: string } | null {
  const img = loadImage(id);
  if (!img || !FILE.test(name)) return null;
  const b = img.manifest.builds[0];
  const allowed = new Set([...(b?.parts.map((p) => p.path) ?? []), ...(b?.ota ? [b.ota.path] : [])]);
  if (!allowed.has(name)) return null;
  const path = join(img.dir, name);
  return existsSync(path) ? { path, type: "application/octet-stream" } : null;
}
