/**
 * The smart-home inventory as it exists in Home Assistant on 2026-09-12.
 * Shared by server and client (no secrets here). Positions are defaults for
 * the floor plan; the user's own placements live in the `home_layout` table
 * and override these.
 *
 * Coordinates are percentages of the room box (0..100) so the plan scales
 * with the viewport.
 */

export type RoomId = "bedroom" | "living_room" | "kitchen" | "office";

export type DeviceKind =
  | "light"
  | "strip"
  | "projector"
  | "ac"
  | "tv"
  | "display"
  | "monitor"
  | "sensor"
  | "presence"
  | "door"
  | "pc"
  | "proxy";

export type CatalogDevice = {
  /** Stable id used as the layout key. */
  id: string;
  name: string;
  kind: DeviceKind;
  /** Primary controllable entity, if any. */
  entity?: string;
  /** Extra entities shown on the detail sheet (sensors, selects, switches). */
  entities?: string[];
  room: RoomId;
  x: number;
  y: number;
  /** For lights: what part of the screen HyperHDR maps onto it. */
  ambilight?: "top" | "left" | "right" | "full" | "pc";
  /** HA advertises colour modes the firmware rejects (Tuya work_mode enum lacks `colour`). */
  whiteOnly?: boolean;
  /** How the device joined HA — shown as a small caption. */
  via: string;
  notes?: string;
};

export const ROOMS: Array<{ id: RoomId; name: string; x: number; y: number; w: number; h: number }> = [
  { id: "bedroom", name: "Bedroom", x: 2, y: 2, w: 46, h: 56 },
  { id: "living_room", name: "Living Room", x: 52, y: 2, w: 46, h: 56 },
  { id: "kitchen", name: "Kitchen", x: 52, y: 62, w: 46, h: 36 },
  { id: "office", name: "Office", x: 2, y: 62, w: 46, h: 36 },
];

export const DEVICES: CatalogDevice[] = [
  // --- Bedroom: the movie setup lives here ---
  { id: "pc", name: "Gaming PC", kind: "pc", room: "bedroom", x: 22, y: 78, ambilight: "pc", via: "OpenRGB SDK",
    notes: "Under the desk. Case strips + GPU + board glow follow the screen." },
  { id: "monitor", name: "Odyssey OLED G8 34\"", kind: "monitor", room: "bedroom", x: 22, y: 55, via: "Samsung SmartThings TV",
    entity: "media_player.34_odyssey_oled_g8_ls34dg850suxdu", entities: ["remote.34_odyssey_oled_g8_ls34dg850suxdu", "media_player.34_odyssey_oled_g8_2"],
    notes: "HyperHDR captures this display (DX11, HDR tone-mapped, 60 fps)." },
  { id: "dxlight", name: "DX Light strip (65 LEDs)", kind: "strip", room: "bedroom", x: 22, y: 44, ambilight: "full", via: "USB HID → HyperHDR",
    notes: "Behind the monitor. Right 17 · top 31 · left 17, driven per-LED at ~59 fps." },
  { id: "desk_bar", name: "Desk Light Bar", kind: "light", entity: "light.desk_light_bar", room: "bedroom", x: 22, y: 30, via: "Tuya", whiteOnly: true,
    notes: "White only: the firmware rejects colour, so movie mode just dims it warm." },
  { id: "led_argb", name: "LED ARGB strip (MELK)", kind: "strip", entity: "light.led_argb", room: "bedroom", x: 8, y: 20, ambilight: "full", via: "Bluetooth proxy · elkbledom",
    entities: ["switch.mic_enable_led_argb", "select.mic_effect_led_argb", "select.brightness_mode_led_argb"],
    notes: "One colour for the whole strip (controller limit) — WLED upgrade documented." },
  { id: "star", name: "Star Projector", kind: "projector", entity: "light.star_projector", room: "bedroom", x: 40, y: 12, via: "Tuya" },
  { id: "ac_bedroom", name: "AC", kind: "ac", entity: "climate.bedroom_ac", room: "bedroom", x: 40, y: 40, via: "ConnectLife (Hisense)",
    entities: ["switch.bedroom_ac_eco", "switch.bedroom_ac_super", "switch.bedroom_ac_purifier", "switch.bedroom_ac_fresh_air", "switch.bedroom_ac_vertical_swing", "switch.bedroom_ac_horizontal_swing", "select.bedroom_ac_sleep_mode", "sensor.bedroom_ac_daily_energy"] },
  { id: "display_bedroom", name: "Bedroom Smart Display", kind: "display", entity: "media_player.bedroom_smart_display", room: "bedroom", x: 8, y: 88, via: "Google Cast" },
  { id: "temp", name: "Temperature & humidity", kind: "sensor", room: "bedroom", x: 40, y: 88, via: "Tuya",
    entity: "sensor.temperature_and_humidity_sensor_temperature",
    entities: ["sensor.temperature_and_humidity_sensor_humidity", "sensor.temperature_and_humidity_sensor_battery"] },
  { id: "presence", name: "Presence (WENZI-II)", kind: "presence", entity: "binary_sensor.human_presence_sensor_occupancy", room: "bedroom", x: 8, y: 50, via: "Tuya mmWave" },

  // --- Living room ---
  { id: "ac_living", name: "AC Mami", kind: "ac", entity: "climate.living_room_ac_mami", room: "living_room", x: 80, y: 15, via: "ConnectLife (Hisense)",
    entities: ["switch.living_room_ac_mami_eco", "switch.living_room_ac_mami_super", "switch.living_room_ac_mami_purifier", "switch.living_room_ac_mami_fresh_air", "switch.living_room_ac_mami_vertical_swing", "select.living_room_ac_mami_sleep_mode", "sensor.living_room_ac_mami_daily_energy"] },
  { id: "tv_living", name: "Sufragerie TV", kind: "tv", entity: "media_player.sufragerie", room: "living_room", x: 50, y: 50, via: "Google Cast" },
  { id: "door", name: "Main Door", kind: "door", entity: "binary_sensor.main_door_door", room: "living_room", x: 92, y: 85, via: "Tuya" },

  // --- Kitchen ---
  { id: "tv_kitchen", name: "Kitchen TV", kind: "tv", entity: "media_player.kitchen_tv", room: "kitchen", x: 50, y: 30, via: "Google Cast" },

  // --- Office ---
  { id: "btproxy", name: "Bluetooth Proxy (ESP32)", kind: "proxy", room: "office", x: 50, y: 50, via: "ESPHome",
    entities: ["button.bluetooth_proxy_1_restart"], notes: "Hears the BLE strip for HA; the VM has no radios." },
];

export const AMBILIGHT_MODES = [
  { id: "movie", name: "Movie", script: "movie_mode_on", description: "Screen drives every light. Star projector off." },
  { id: "music", name: "Music", script: "music_mode", description: "Audio-reactive, Voicemeeter B1." },
  { id: "off", name: "Warm room", script: "movie_mode_off", description: "Grabber off; 3000 K at 60 %." },
] as const;

type Rgb = readonly [number, number, number];

/**
 * Live-stream lighting scenes (TikSee / codai agents via MCP `scene_set`).
 * Each id maps to `script.stream_scene_<id>` in pi/ha-packages/vmui_stream.yaml;
 * every scene script snapshots the RGB bulbs, sets its look and restores the
 * snapshot after the duration (mode: restart + stopping the other scenes, so
 * the newest call wins). `default` is the restore itself. Strips (DX, case,
 * MELK) are driven through HyperHDR at priority 30 — never light.led_argb
 * directly, the MELK bridge owns its BLE link. The desk bar is white-only.
 */
export const STREAM_BULBS = ["light.moodlight", "light.ambience_light"] as const;
/** RGB room lights a `stream` key may address with lights_set (scope `entities`). */
export const STREAM_ENTITIES = ["light.moodlight", "light.ambience_light", "light.led_argb", "light.hyperhdr"] as const;

export const STREAM_SCENES = [
  { id: "party", label: { ro: "Petrecere", en: "Party" }, entity: "script.stream_scene_party", defaultDurationSec: 20, maxDurationSec: 60,
    colors: [[255, 0, 200], [0, 220, 255]] as Rgb[], description: "Magenta/cyan alternating bulbs, Plasma on the strips." },
  { id: "calm", label: { ro: "Calm", en: "Calm" }, entity: "script.stream_scene_calm", defaultDurationSec: 60, maxDurationSec: 600,
    colors: [[90, 60, 200]] as Rgb[], description: "Dim violet bulbs, slow cold mood blobs on the strips." },
  { id: "red_alert", label: { ro: "Alertă roșie", en: "Red alert" }, entity: "script.stream_scene_red_alert", defaultDurationSec: 8, maxDurationSec: 20,
    colors: [[255, 0, 0]] as Rgb[], description: "Pulsing red everywhere." },
  { id: "gift_gold", label: { ro: "Cadou auriu", en: "Gold gift" }, entity: "script.stream_scene_gift_gold", defaultDurationSec: 10, maxDurationSec: 30,
    colors: [[255, 180, 0]] as Rgb[], description: "Full-brightness gold for a big gift." },
  { id: "rainbow", label: { ro: "Curcubeu", en: "Rainbow" }, entity: "script.stream_scene_rainbow", defaultDurationSec: 20, maxDurationSec: 60,
    colors: [[255, 0, 0], [255, 160, 0], [255, 255, 0], [0, 255, 0], [0, 120, 255], [160, 0, 255]] as Rgb[], description: "Bulbs cycle hues, rainbow swirl on the strips." },
  { id: "blackout_flash", label: { ro: "Blackout cu flash", en: "Blackout flash" }, entity: "script.stream_scene_blackout_flash", defaultDurationSec: 4, maxDurationSec: 8,
    colors: [[0, 0, 0], [255, 255, 255]] as Rgb[], description: "Lights out, three white strobes, then dark until restore." },
  { id: "default", label: { ro: "Normal", en: "Default" }, entity: "script.stream_scene_default", defaultDurationSec: 0, maxDurationSec: 0,
    colors: [] as Rgb[], description: "Stop any stream effect and restore the lights as they were." },
] as const;

export type StreamSceneId = (typeof STREAM_SCENES)[number]["id"];

/** HA script names a stream key may reach (scene_set / flash_color scope keys). */
export const STREAM_SCRIPTS = [...STREAM_SCENES.map((s) => s.entity.replace(/^script\./, "")), "stream_flash"];

export const MUSIC_EFFECTS = [
  "Music: stereo for LED strip (MULTI COLOR)",
  "Music: stereo for LED strip (MULTI COLOR FAST)",
  "Music: quatro for LED strip (MULTI COLOR)",
  "Music: pulse waves for LED strip (MULTI COLOR)",
  "Music: fullscreen pulse (MULTI COLOR)",
  "Music: fullscreen pulse (WHITE)",
] as const;

export const AMBIENT_EFFECTS = [
  "Warm mood blobs", "Cold mood blobs", "Full color mood blobs", "Sea waves", "Rainbow swirl", "Plasma", "Candle", "Breath",
] as const;

export const HYPERHDR_INSTANCES = [
  { id: 0, name: "DX Light (monitor)", target: "65-LED strip behind the OLED", fps: 60 },
  { id: 1, name: "PC glow (OpenRGB)", target: "Case strips · GPU · board", fps: 20 },
  { id: 2, name: "Room lights (HA)", target: "MELK strip (whole screen)", fps: 3 },
] as const;

export const NOTIFY_PALETTE: Array<{ app: string; label: string; color: [number, number, number] }> = [
  { app: "com.whatsapp", label: "WhatsApp", color: [37, 211, 102] },
  { app: "com.samsung.android.dialer", label: "Phone", color: [0, 120, 255] },
  { app: "com.samsung.android.messaging", label: "Messages", color: [120, 80, 255] },
  { app: "com.google.android.gm", label: "Gmail", color: [234, 67, 53] },
];
