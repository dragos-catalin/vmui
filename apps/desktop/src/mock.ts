// Browser-only harness: when the page is NOT inside Tauri (`window.__TAURI_INTERNALS__`
// missing) we answer `invoke()` from a small in-memory stub so the UI can be
// driven in a normal browser (Playwright) without taking the user's screen.
// Never bundled in the app: main.tsx imports it only under ?mock=1.
type Handler = (args: Record<string, unknown>) => unknown;

const settings: Record<string, unknown> = { wallHex: "#439ebf", wallStrength: 0.5, gamma: 1, saturation: 1, luminance: 1, idleStripHex: "#a00000", idleGlowHex: "#500000", idleAfterSec: 20, stripSmoothMs: 150, glowSmoothMs: 700, roomSmoothMs: 800, roomBrightness: 140, grabberFps: 60, hdrToneMapping: true, videoFollow: true, videoAutoMovie: true };
const tasks = ["vmui-ambilight-hyperhdr", "vmui-ambilight-openrgb", "vmui-ambilight-bridges", "vmui-service", "vmui-turzx", "vmui-tray"].map((name, i) => ({ name, status: i === 3 ? "Ready" : "Running", running: i !== 3 }));
const VMUI = "/vmui";
const K = new URLSearchParams(location.search).get("k") ?? "";
const calls: Array<{ cmd: string; args: unknown }> = [];
let lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ro";
const caps = { onoff: true, brightness: true, rgb: true, kelvin: null, effects: ["Breath", "Rainbow"], addressable: false, segments: true, ledCountConfig: true, whiteOnly: false };
const lights = {
  devices: [
    { id: "melk_oa10", name: "Bandă pat", room: "bedroom", transport: "ble", address: "BE:69:83:00:C4:0B", protocol: "melk", capabilities: caps, calibration: {}, ledCount: 60, enabled: true, health: "ok", lastSeenAt: Date.now(), lastLatencyMs: 40, lastError: null, state: { on: true, rgb: [255, 120, 40], brightnessPct: 70 },
      segments: [{ id: "melk_oa10-s0", deviceId: "melk_oa10", ord: 0, name: "Pat", ledStart: 0, ledCount: 36, reverse: false, calibration: {} }, { id: "melk_oa10-s1", deviceId: "melk_oa10", ord: 1, name: "Birou", ledStart: 36, ledCount: 24, reverse: false, calibration: {} }] },
    { id: "desk_bar", name: "Bară birou", room: "bedroom", transport: "ha", address: "light.desk_light_bar", protocol: null, capabilities: { ...caps, rgb: false, whiteOnly: true, kelvin: [2700, 6500], effects: [], segments: false, ledCountConfig: false }, calibration: {}, ledCount: 1, segments: [], enabled: true, health: "degraded", lastSeenAt: null, lastLatencyMs: 900, lastError: null, state: { on: false } },
  ],
  groups: [], scenes: [{ id: "s1", name: "Seară" }], profiles: [{ id: "day", name: "Zi", calibration: {}, active: true }, { id: "night", name: "Noapte", calibration: { briCap: 0.4 }, active: false }],
  rooms: [{ id: "bedroom", name: "Dormitor" }], pcOnline: true, haOnline: true, discovered: [],
};
(window as unknown as { __calls: unknown }).__calls = calls;

const handlers: Record<string, Handler> = {
  health: () => ({ state: "ok", detail: "idle · captură oprită", vmui: true, ha: true, hyper: true, grabber: false, source: "idle", tasks }),
  tasks: () => tasks,
  task_action: () => undefined,
  tail_log: ({ name }) => `${name}: 12:00:01 mock line 1\n12:00:02 mock line 2`,
  open_path: () => undefined,
  settings_get: () => settings,
  settings_set: ({ patch }) => Object.assign(settings, patch as object),
  ambilight_configure: () => "ok",
  hyper_instances: () => [0, 1, 2].map((id) => ({ id, name: ["First LED instance", "PC glow", "Room lights"][id], running: true, grabber: false, source: "idle", brightness: 100, effects: ["Breath", "Fire"] })),
  hyper_send: () => [],
  ambilight_mode: () => undefined,
  pc_action: ({ action }) => `${action} ok`,
  ha_call: () => ({}),
  vmui_get: async ({ path }) => { const p = String(path); const r = await fetch(`${VMUI}${p}${p.includes("?") ? "&" : "?"}k=${K}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
  vmui_send: async ({ method, path, body }) => { const p = String(path); const r = await fetch(`${VMUI}${p}${p.includes("?") ? "&" : "?"}k=${K}`, { method: String(method), headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json().catch(() => ({ ok: true })); },
  app_info: () => ({ root: "E:\\gh\\vmui", vmui: VMUI, haUrl: "", displayUrl: `${VMUI}/display?k=${K}`, version: "mock" }),
  lang_get: () => lang,
  app_ready: () => true,
  lang_set: ({ lang: l }) => { lang = l === "en" ? "en" : "ro"; },
  lights_get: () => lights,
  lights_op: ({ body }) => { calls.push({ cmd: "lights_op:body", args: body }); return { ok: true }; },
  ble_scan: () => [{ mac: "BE:16:2F:00:05:29", name: "MELK-OC21", rssi: -58, protocol: "melk" }],
  ble_status: () => [{ mac: "BE:69:83:00:C4:0B", connected: true, latencyMs: 42, lastError: null }],
  pi_status: async ({ log }) => handlers.vmui_get!({ path: `/api/desktop/pi${log ? `?log=${String(log)}` : ""}` }),
  "plugin:event|listen": () => 0,
  "plugin:event|unlisten": () => undefined,
  "plugin:autostart|is_enabled": () => false,
  "plugin:window|hide": () => undefined,
  "plugin:window|minimize": () => undefined,
  "plugin:window|toggle_maximize": () => undefined,
  "plugin:opener|open_url": () => undefined,
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" }, windows: [{ label: "main" }], webviews: [{ label: "main" }] },
  transformCallback: (cb: (v: unknown) => void) => { const id = Math.floor(Math.random() * 1e9); (window as unknown as Record<string, unknown>)[`_${id}`] = cb; return id; },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`mock: no handler for ${cmd}`);
    return h(args);
  },
  convertFileSrc: (p: string) => p,
};
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };

export { };

