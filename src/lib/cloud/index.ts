import "server-only";

import { credential } from "@/lib/home/credentials";
import { getTlsContext, hasUsableCert, issueCertificate, publishCertStatus, readCertState, refreshRenewAt } from "./acme";
import { cloudStatus, patchCloudStatus, setTunnelState, type CloudStatus } from "./status";
import { fetchRelayToken, startTunnel, type TunnelHandle } from "./tunnel";

// Vatra Cloud lifecycle: certificate renewal loop + relay tunnel while remote access is on
// (VATRA_CLOUD_REMOTE=1). Idempotent: call startVatraCloud() at boot and reconcileVatraCloud()
// after the owner flips a setting.

const TICK_MS = 60 * 60_000;
const RETRY_FAILED_MS = 6 * 60 * 60_000;

type Runtime = { tunnel: TunnelHandle | null; timer: NodeJS.Timeout | null; busy: boolean };
const g = globalThis as { __vatraCloud?: Runtime };
const rt = (): Runtime => (g.__vatraCloud ??= { tunnel: null, timer: null, busy: false });

export const remoteEnabled = (): boolean => credential("VATRA_CLOUD_REMOTE") === "1";
export const pushEnabled = (): boolean => credential("VATRA_CLOUD_PUSH") === "1";

const log = (msg: string) => console.warn(`[vatra-cloud] ${msg}`);

async function hostname(): Promise<string> {
  const { cloudHostname } = await import("./identity");
  return cloudHostname();
}

/** Issue when missing / for another host / due; never hammer the CA after a failure. */
async function ensureCertificate(now = Date.now()): Promise<void> {
  const host = await hostname();
  patchCloudStatus({ host });
  const s = readCertState();
  const failedRecently = !!s?.lastError && !!s.lastAttemptAt && now - s.lastAttemptAt < RETRY_FAILED_MS;
  if (!hasUsableCert(host)) {
    if (!failedRecently) await issueCertificate(host);
    return;
  }
  const fresh = await refreshRenewAt(now).catch(() => s);
  if (fresh && fresh.renewAt <= now && !failedRecently) await issueCertificate(host);
}

async function tick(): Promise<void> {
  const r = rt();
  if (r.busy) return;
  r.busy = true;
  try {
    if (!remoteEnabled()) {
      stopTunnel();
      return;
    }
    try {
      await ensureCertificate();
    } catch (e) {
      log(`certificate: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!getTlsContext()) {
      setTunnelState("error", "no_certificate");
      return;
    }
    r.tunnel ??= startTunnel({
      fetchToken: fetchRelayToken,
      configuredPin: () => credential("VATRA_CLOUD_RELAY_PIN") ?? null,
      secureContext: getTlsContext,
      localHost: "127.0.0.1",
      localPort: Number(process.env.PORT ?? 3737),
      now: Date.now,
    });
  } finally {
    r.busy = false;
  }
}

function stopTunnel(): void {
  const r = rt();
  r.tunnel?.stop();
  r.tunnel = null;
  setTunnelState("off", null);
}

/** Boot entry point (instrumentation, nodejs runtime only). Safe to call more than once. */
export function startVatraCloud(): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VATRA_DEMO === "1") return;
  const r = rt();
  if (r.timer) return;
  publishCertStatus();
  r.timer = setInterval(() => void tick(), TICK_MS);
  r.timer.unref?.();
  void tick();
}

/** Apply a settings change now (enable/disable remote access). */
export async function reconcileVatraCloud(): Promise<CloudStatus> {
  const r = rt();
  if (!r.timer) startVatraCloud();
  else await tick();
  return cloudStatus();
}

/** Force a new certificate (owner button); the tunnel picks it up on the next TLS handshake. */
export async function renewCertificateNow(): Promise<void> {
  await issueCertificate(await hostname());
}

export { cloudStatus } from "./status";
