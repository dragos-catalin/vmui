import "server-only";

// Live Vatra Cloud state (tunnel + certificate), shared by the tunnel, the renewal loop and the
// settings card. Kept on globalThis: Next can load this module more than once per process.

export type TunnelState = "off" | "connecting" | "online" | "error";

export type CloudStatus = {
  state: TunnelState;
  since: number;
  lastError: string | null;
  host: string | null;
  certNotAfter: number | null;
  certRenewAt: number | null;
  certError: string | null;
  clients: number;
};

const g = globalThis as { __vatraCloudStatus?: CloudStatus };

function current(): CloudStatus {
  g.__vatraCloudStatus ??= { state: "off", since: Date.now(), lastError: null, host: null, certNotAfter: null, certRenewAt: null, certError: null, clients: 0 };
  return g.__vatraCloudStatus;
}

export function cloudStatus(): CloudStatus {
  return { ...current() };
}

export function setTunnelState(state: TunnelState, error?: string | null): void {
  const s = current();
  if (s.state !== state) {
    s.state = state;
    s.since = Date.now();
  }
  if (error !== undefined) s.lastError = error;
  if (state === "off") s.clients = 0;
}

export function patchCloudStatus(patch: Partial<Omit<CloudStatus, "state" | "since">>): void {
  Object.assign(current(), patch);
}

export function clientDelta(n: number): void {
  const s = current();
  s.clients = Math.max(0, s.clients + n);
}

/** Test seam. */
export function resetCloudStatus(): void {
  delete g.__vatraCloudStatus;
}
