#!/usr/bin/env node
// Live smoke test of the demo hub (P10-04). Never prints a secret.
//   BASE=https://vatra-demo-xxxx.run.app VATRA_DEMO_REVIEW_PASSWORD=... VATRA_DEMO_INVITE=... node deploy/demo/smoke.mjs
// Checks: /api/discover claimed:true; reviewer sign-in (app login path); pairing through the static
// invite twice (not consumed); /api/v1/app/state with that device token; /api/backup/restore 403 demo_readonly.

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const PASSWORD = process.env.VATRA_DEMO_REVIEW_PASSWORD ?? "";
const INVITE = process.env.VATRA_DEMO_INVITE ?? "";
const EMAIL = "review@vatra.dragoscatalin.ro";

if (!BASE || !PASSWORD || !INVITE) {
  console.error("usage: BASE, VATRA_DEMO_REVIEW_PASSWORD and VATRA_DEMO_INVITE must be set");
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

const pair = (body) => call("/api/devices/pair", { method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": "en" }, body: JSON.stringify(body) });

const discover = await call("/api/discover");
check("discover claimed", discover.status === 200 && discover.json?.claimed === true, `status ${discover.status}`);

const login = await pair({ name: "smoke-login", platform: "smoke", email: EMAIL, password: PASSWORD });
check("reviewer sign-in", login.status === 200 && login.json?.status === "approved", `status ${login.status}`);

const a = await pair({ name: "smoke-invite-1", platform: "android", invite: INVITE });
const b = await pair({ name: "smoke-invite-2", platform: "ios", invite: INVITE });
check("static invite pairs", a.status === 200 && typeof a.json?.token === "string", `status ${a.status}`);
check("static invite not consumed", b.status === 200 && typeof b.json?.token === "string", `status ${b.status}`);

const token = a.json?.token;
if (token) {
  const state = await call("/api/v1/app/state", { headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en" } });
  const rooms = Array.isArray(state.json?.rooms) ? state.json.rooms.length : Array.isArray(state.json?.data?.rooms) ? state.json.data.rooms.length : null;
  check("app state", state.status === 200, `status ${state.status}${rooms !== null ? `, ${rooms} rooms` : ""}`);
} else check("app state", false, "no device token");

const fd = new FormData();
fd.set("file", new Blob([new Uint8Array([1, 2, 3])]), "x.vatra");
fd.set("passphrase", "not-a-real-passphrase");
const restore = await call("/api/backup/restore", { method: "POST", body: fd, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
check("restore refused", restore.status === 403 && restore.json?.code === "demo_readonly", `status ${restore.status}, code ${restore.json?.code ?? "-"}`);

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
