import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "server-only";

/**
 * The PowerShell scripts read `.private/credentials.env` through
 * `scripts/lib/guest-credentials.ps1`. The web app needs the same values
 * (HA_URL, HA_TOKEN, HA_PUBLIC_DOMAIN) and must never diverge from them, so
 * it reads the same file. Precedence matches the ps1: env var wins.
 */
const CANDIDATES = [
  process.env.VMUI_CREDENTIALS_FILE,
  join(process.cwd(), ".private", "credentials.env"),
  join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".vmui", "credentials.env"),
].filter((p): p is string => Boolean(p));

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  for (const file of CANDIDATES) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in out)) out[key] = value;
    }
    break;
  }
  cache = out;
  return out;
}

export function credential(key: string): string | undefined {
  return process.env[key] ?? fromStore(key) ?? load()[key] ?? supervisor(key);
}

/** Inside a Home Assistant OS add-on (homeassistant_api: true) the Supervisor proxies Core at
 *  http://supervisor/core with the add-on's own SUPERVISOR_TOKEN: the HAOS add-on (P5-05) works
 *  with no HA token pasted. Anything configured explicitly still wins. */
function supervisor(key: string): string | undefined {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || process.env.VATRA_HAOS_ADDON !== "1") return undefined;
  if (key === "HA_URL") return "http://supervisor/core";
  if (key === "HA_TOKEN") return token;
  return undefined;
}

/** Encrypted settings written from the UI. lib/integrations.ts registers itself here
 *  (credentials.ts must not import the db: scripts and the env loader use it). */
type StoreReader = (key: string) => string | undefined;
const reg = globalThis as { __vatraCredStore__?: StoreReader };
export function registerCredentialStore(r: StoreReader): void {
  reg.__vatraCredStore__ = r;
}
function fromStore(key: string): string | undefined {
  try {
    return reg.__vatraCredStore__?.(key);
  } catch {
    return undefined;
  }
}

export function haConfig(): { url: string; token: string; publicDomain?: string } | null {
  const url = credential("HA_URL");
  const token = credential("HA_TOKEN");
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token, publicDomain: credential("HA_PUBLIC_DOMAIN") };
}
