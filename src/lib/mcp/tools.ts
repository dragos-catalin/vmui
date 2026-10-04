import "server-only";

import type { ScopeKey } from "@/lib/api-key-scopes";
import { getCodaiLink } from "@/lib/codai/links";
import { provisionCodaiEnvironment, refreshCodaiStatus } from "@/lib/codai/provision";
import { db } from "@/lib/db";
import { auditLog, instances } from "@/lib/db/schema";
import { showMessage } from "@/lib/esp/gallery";
import { AMBILIGHT_MODES, DEVICES, STREAM_SCENES } from "@/lib/home/catalog";
import { ha } from "@/lib/home/ha-client";
import { armAutoOpen, ignoreCall, intercomState, openDoor } from "@/lib/home/intercom";
import { FLASH_COLORS, flashColorSchema, resolveFlashColor, resolveScene, sceneScopeId, sceneSetSchema } from "@/lib/home/stream";
import { pcIsUp, pcTarget, wakePc } from "@/lib/home/wol";
import type { EffectKind } from "@/lib/mcp/effect-limiter";
import { executeInstanceAction, syncAccountInstances } from "@/server/actions/instances";
import { eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

/**
 * The fixed vocabulary an agent (codai phone / desktop) may use against this
 * house and this PC. Every tool is described well enough for a model to pick
 * it without guessing entity ids, validated with zod, and audit-logged.
 *
 * `destructive: true` is surfaced through MCP annotations so the client can
 * show an ask-card before running it (door, sleep/lock, VM stop/terminate).
 */

type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export type McpTool = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  destructive?: boolean;
  readOnly?: boolean;
  /** Which per-key argument limit (Settings -> API keys -> scope) applies to a call with these args. */
  scopeKey?: (args: Record<string, unknown>) => ScopeKey | undefined;
  /**
   * Physical light effect: /api/mcp runs it through the effect limiter (per-key cooldown,
   * burst merge, idempotencyKey dedupe). `bypass` skips the cooldown (restore/stop).
   */
  effect?: { kind: EffectKind; bypass?: (args: Record<string, unknown>) => boolean };
  run: (args: Record<string, unknown>, by: string) => Promise<ToolResult>;
};

const entityId = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/);
const rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);

const known = new Map<string, { name: string; room: string; kind: string; whiteOnly?: boolean }>();
for (const d of DEVICES) {
  for (const e of [d.entity, ...(d.entities ?? [])]) {
    if (e) known.set(e, { name: d.name, room: d.room, kind: d.kind, whiteOnly: d.whiteOnly });
  }
}
known.set("light.hyperhdr", { name: "Ambilight (HyperHDR)", room: "bedroom", kind: "strip" });

function assertKnown(entity: string) {
  if (!known.has(entity)) throw new Error(`Unknown entity ${entity}; call home_devices for the list`);
}

const NEST_HUB = "media_player.bedroom_smart_display";

const entityKey = (args: Record<string, unknown>): ScopeKey | undefined =>
  typeof args.entity === "string" ? { kind: "entity", id: args.entity } : undefined;

async function audit(action: string, target: string, message: string, by: string, status: "ok" | "error" = "ok") {
  await db.insert(auditLog).values({ accountId: "mcp", action, target, status, message: `[${by}] ${message}` });
}

async function run(action: string, target: string, message: string, by: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const extra = await fn();
    await audit(action, target, message, by);
    // HA's callService echoes every changed state (kilobytes per call);
    // the model only needs to know it happened.
    const plain = typeof extra === "object" && extra !== null && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
    return { ok: true, ...plain };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await audit(action, target, error, by, "error");
    return { ok: false, error };
  }
}

export const PC_ACTIONS = [
  "lock", "sleep", "display_off", "volume", "mute", "unmute",
  "restart_tunnel", "unfreeze_vscode", "kill_runaway_renderer",
  "restart_ambilight", "restart_turzx", "restart_vmui",
] as const;
const PC_DESTRUCTIVE = new Set<string>(["lock", "sleep", "restart_vmui"]);

function pcAction(action: string, value?: number): Promise<string> {
  const script = path.join(process.cwd(), "scripts", "pc-action.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action];
  if (value !== undefined) args.push("-Value", String(value));
  return new Promise((resolve, reject) => {
    const p = spawn("pwsh", args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim() || `exit ${code}`))));
    setTimeout(() => { p.kill(); reject(new Error("pc-action timed out")); }, 20_000).unref();
  });
}

function summarize(s: { entity_id: string; state: string; attributes: Record<string, unknown> }) {
  const a = s.attributes;
  const pick: Record<string, unknown> = {};
  for (const k of ["brightness", "rgb_color", "color_temp_kelvin", "temperature", "current_temperature", "hvac_mode", "fan_mode", "volume_level", "media_title", "app_name", "is_volume_muted", "unit_of_measurement", "friendly_name"]) {
    if (a[k] !== undefined) pick[k] = a[k];
  }
  return { entity_id: s.entity_id, state: s.state, ...pick };
}

export const TOOLS: McpTool[] = [
  {
    name: "home_devices",
    description: "List every controllable device in the house with its Home Assistant entity id, room and kind. Call this first when unsure which entity a request refers to.",
    schema: z.object({}),
    readOnly: true,
    run: async () => ({ ok: true, devices: [...known.entries()].map(([entity, d]) => ({ entity, ...d })) }),
  },
  {
    name: "home_state",
    description: "Current state of the home: lights, AC, media players (incl. the Nest Hub), door, presence, temperature/humidity, ambilight idle gate. Pass entities to narrow.",
    schema: z.object({ entities: z.array(entityId).max(40).optional() }),
    readOnly: true,
    run: async ({ entities }) => {
      const all = await ha.states();
      const want = (entities as string[] | undefined)?.length ? new Set(entities as string[]) : new Set([...known.keys(), "binary_sensor.main_door_door", "sensor.temperature_and_humidity_sensor_temperature", "sensor.temperature_and_humidity_sensor_humidity", "binary_sensor.room_is_bright", "binary_sensor.vmui_intercom_ringing"]);
      return { ok: true, states: all.filter((s) => want.has(s.entity_id)).map(summarize) };
    },
  },
  {
    name: "lights_set",
    description: "Turn a light on/off or set colour, brightness, warmth. Entities: light.moodlight, light.ambience_light (RGB bulbs), light.desk_light_bar (white only), light.led_argb (MELK strip), light.star_projector, light.hyperhdr (ambilight strip). Use rgb for colour, kelvin for warmth (2700 warm .. 6500 cool).",
    schema: z.object({
      entity: entityId,
      on: z.boolean().default(true),
      rgb: rgb.optional(),
      brightnessPct: z.number().int().min(1).max(100).optional(),
      kelvin: z.number().int().min(1500).max(9000).optional(),
      transition: z.number().min(0).max(10).optional(),
    }),
    scopeKey: entityKey,
    run: ({ entity, on, rgb: color, brightnessPct, kelvin, transition }, by) =>
      run("mcp.light", entity as string, JSON.stringify({ on, color, brightnessPct, kelvin }), by, async () => {
        assertKnown(entity as string);
        if (!on) return ha.callService("light", "turn_off", { entity_id: entity, ...(transition !== undefined ? { transition } : {}) });
        if (color && known.get(entity as string)?.whiteOnly) throw new Error("This light is white-only; use kelvin");
        const data: Record<string, unknown> = { entity_id: entity };
        if (color) data.rgb_color = color;
        if (brightnessPct !== undefined) data.brightness_pct = brightnessPct;
        if (kelvin !== undefined) data.color_temp_kelvin = kelvin;
        if (transition !== undefined) data.transition = transition;
        return ha.callService("light", "turn_on", data);
      }),
  },
  {
    name: "lights_all",
    description: "Turn every room light on or off at once (moodlight, ambience, desk bar, MELK strip, star projector). 'off' is what 'stinge becurile' means.",
    schema: z.object({ on: z.boolean() }),
    run: ({ on }, by) =>
      run("mcp.lights_all", "all", on ? "on" : "off", by, async () => {
        const lights = [...known.keys()].filter((e) => e.startsWith("light.") && e !== "light.hyperhdr");
        await ha.callService("light", on ? "turn_on" : "turn_off", { entity_id: lights });
        return { entities: lights };
      }),
  },
  {
    name: "switch_set",
    description: "Turn a switch/fan/media_player entity on or off (AC eco/super/purifier switches, TVs, Nest Hub).",
    schema: z.object({ entity: entityId, on: z.boolean() }),
    scopeKey: entityKey,
    run: ({ entity, on }, by) =>
      run("mcp.toggle", entity as string, on ? "on" : "off", by, async () => {
        assertKnown(entity as string);
        const domain = (entity as string).split(".")[0] ?? "homeassistant";
        const svc = ["light", "switch", "fan", "media_player", "climate", "humidifier"].includes(domain) ? domain : "homeassistant";
        return ha.callService(svc, on ? "turn_on" : "turn_off", { entity_id: entity });
      }),
  },
  {
    name: "climate_set",
    description: "Control an air conditioner: climate.bedroom_ac or climate.living_room_ac_mami. Set mode (off/cool/heat/dry/fan_only/auto), target temperature 16-30, fan mode.",
    schema: z.object({
      entity: entityId,
      hvacMode: z.enum(["off", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"]).optional(),
      temperature: z.number().min(16).max(30).optional(),
      fanMode: z.string().max(32).optional(),
    }),
    scopeKey: entityKey,
    run: ({ entity, hvacMode, temperature, fanMode }, by) =>
      run("mcp.climate", entity as string, JSON.stringify({ hvacMode, temperature, fanMode }), by, async () => {
        assertKnown(entity as string);
        if (hvacMode) await ha.callService("climate", "set_hvac_mode", { entity_id: entity, hvac_mode: hvacMode });
        if (temperature !== undefined) await ha.callService("climate", "set_temperature", { entity_id: entity, temperature });
        if (fanMode) await ha.callService("climate", "set_fan_mode", { entity_id: entity, fan_mode: fanMode });
      }),
  },
  {
    name: "ambilight_mode",
    description: `Set the ambilight/room lighting mode. ${AMBILIGHT_MODES.map((m) => `${m.id}: ${m.description}`).join(" | ")}`,
    schema: z.object({ mode: z.enum(AMBILIGHT_MODES.map((m) => m.id) as [string, ...string[]]) }),
    run: ({ mode }, by) => {
      const m = AMBILIGHT_MODES.find((x) => x.id === mode)!;
      return run("mcp.ambilight_mode", m.id, m.name, by, () => ha.runScript(m.script));
    },
  },
  {
    name: "notify_flash",
    description: "Flash all ambilight LEDs in a colour for a moment (visual notification). Default 1.5 s.",
    schema: z.object({ color: rgb, durationMs: z.number().int().min(200).max(15000).default(1500) }),
    effect: { kind: "flash" },
    run: ({ color, durationMs }, by) =>
      run("mcp.flash", (color as number[]).join(","), `${durationMs}ms`, by, () => ha.runScript("notify_flash", { color, duration_ms: durationMs })),
  },
  {
    name: "scene_list",
    description: "List the live-stream lighting scenes scene_set accepts, with labels (ro/en), default and maximum duration and colours.",
    schema: z.object({}),
    readOnly: true,
    run: async () => ({
      ok: true,
      scenes: STREAM_SCENES.map((s) => ({ id: s.id, label: s.label, description: s.description, defaultDurationSec: s.defaultDurationSec, maxDurationSec: s.maxDurationSec, colors: s.colors })),
      flashColors: Object.keys(FLASH_COLORS),
    }),
  },
  {
    name: "scene_set",
    description:
      "Play a live-stream lighting scene on the room bulbs and LED strips, then restore the lights exactly as they were after durationSec. The newest call replaces a running scene; scene 'default' stops any scene and restores at once. Rate-limited per key (one scene per 10 s; extra calls in the window merge into one, last wins, answered {limited:true, retryAfterMs}). Pass idempotencyKey (e.g. the gift event id) so retries never fire twice.",
    schema: sceneSetSchema,
    scopeKey: ({ scene }) => {
      const id = sceneScopeId(scene);
      return id ? { kind: "script", id } : undefined;
    },
    effect: { kind: "scene", bypass: ({ scene }) => scene === "default" },
    run: (args, by) => {
      const target = typeof args.scene === "string" ? args.scene : "?";
      return run("mcp.scene", target, `${String(args.durationSec ?? "default")}s`, by, async () => {
        const s = resolveScene(args as { scene: (typeof STREAM_SCENES)[number]["id"]; durationSec?: number });
        // script.turn_on returns at once; calling script/<name> would block for the whole scene.
        await ha.callService("script", "turn_on", { entity_id: `script.${s.script}`, variables: { duration_sec: s.durationSec } });
        return { scene: s.id, durationSec: s.durationSec };
      });
    },
  },
  {
    name: "flash_color",
    description:
      "Flash every ambilight LED strip (monitor, PC case, MELK room strip) in a colour 1-5 times; the strips fall back on their own, nothing to restore. Give rgb [r,g,b] or a colour name. Rate-limited per key (one flash per 1.5 s; extra calls merge, last wins, answered {limited:true, retryAfterMs}).",
    schema: flashColorSchema,
    scopeKey: () => ({ kind: "script", id: "stream_flash" }),
    effect: { kind: "flash" },
    run: (args, by) => {
      const count = args.count as number;
      const durationMs = args.durationMs as number;
      return run("mcp.flash_color", String(args.color ?? (args.rgb as number[] | undefined)?.join(",") ?? "?"), `${count}x${durationMs}ms`, by, async () => {
        const color = resolveFlashColor(args as { rgb?: [number, number, number]; color?: keyof typeof FLASH_COLORS });
        await ha.callService("script", "turn_on", { entity_id: "script.stream_flash", variables: { color, count, duration_ms: durationMs } });
        return { color, count, durationMs };
      });
    },
  },
  {
    name: "media_command",
    description: `Control a media player: play_pause, volume_up/down, volume_mute, volume_set (0-100), turn_on/off. Players: ${NEST_HUB} (Google Nest Hub in the bedroom), media_player.sufragerie (living room Chromecast), media_player.kitchen_tv, media_player.34_odyssey_oled_g8_ls34dg850suxdu (PC monitor).`,
    schema: z.object({
      entity: entityId.default(NEST_HUB),
      command: z.enum(["play_pause", "volume_up", "volume_down", "volume_mute", "volume_set", "turn_on", "turn_off", "stop"]),
      volumePct: z.number().int().min(0).max(100).optional(),
    }),
    scopeKey: entityKey,
    run: ({ entity, command, volumePct }, by) =>
      run("mcp.media", entity as string, command as string, by, async () => {
        assertKnown(entity as string);
        const data: Record<string, unknown> = { entity_id: entity };
        let svc = command as string;
        if (command === "play_pause") svc = "media_play_pause";
        if (command === "stop") svc = "media_stop";
        if (command === "volume_mute") data.is_volume_muted = true;
        if (command === "volume_set") {
          if (volumePct === undefined) throw new Error("volume_set needs volumePct");
          data.volume_level = (volumePct as number) / 100;
        }
        return ha.callService("media_player", svc, data);
      }),
  },
  {
    name: "nest_hub_say",
    description: "Speak a short message aloud on the Google Nest Hub (bedroom) via text-to-speech. Romanian or English. Use for announcements like 'build finished'.",
    schema: z.object({ message: z.string().min(1).max(300), language: z.enum(["ro", "en"]).default("ro"), entity: entityId.default(NEST_HUB) }),
    scopeKey: entityKey,
    run: ({ message, language, entity }, by) =>
      run("mcp.tts", entity as string, (message as string).slice(0, 80), by, () =>
        ha.callService("tts", "speak", {
          entity_id: "tts.google_translate_en_com",
          media_player_entity_id: entity,
          message,
          language: language === "ro" ? "ro" : "en",
        }).catch(() => ha.callService("tts", "google_translate_say", { entity_id: entity, message, language })),
      ),
  },
  {
    name: "nest_hub_show",
    description: "Cast a Home Assistant dashboard view onto the Nest Hub screen. viewPath is the view's URL path ('0' = first view of the default dashboard). keep=true arms continuous casting: HA re-sends the view whenever the Hub drops it (~10 min idle), until nest_hub_stop.",
    schema: z.object({ viewPath: z.string().min(1).max(64).default("0"), dashboardPath: z.string().max(64).default("lovelace"), keep: z.boolean().default(false), entity: entityId.default(NEST_HUB) }),
    scopeKey: entityKey,
    run: ({ viewPath, dashboardPath, keep, entity }, by) =>
      run("mcp.cast", entity as string, `${dashboardPath}/${viewPath}${keep ? " (keep)" : ""}`, by, () =>
        keep
          // script.turn_on is fire-and-forget; calling script/<name> directly blocks on
          // cast.show_lovelace_view and HA answers 400 when it times out.
          ? ha.callService("script", "turn_on", { entity_id: "script.vmui_cast_start", variables: { view_path: viewPath, dashboard_path: dashboardPath } })
          : ha.callService("cast", "show_lovelace_view", { entity_id: entity, view_path: viewPath, dashboard_path: dashboardPath }),
      ),
  },
  {
    name: "nest_hub_stop",
    description: "Stop casting to the Nest Hub and disarm continuous casting (back to the ambient photo frame).",
    schema: z.object({}),
    scopeKey: () => ({ kind: "entity", id: NEST_HUB }),
    run: (_a, by) => run("mcp.cast_stop", NEST_HUB, "stop", by, () => ha.callService("script", "turn_on", { entity_id: "script.vmui_cast_stop" })),
  },
  {
    name: "ha_script",
    description: "Run a Home Assistant script by name (e.g. movie_mode_on, movie_mode_off, music_mode, copilot_done). Only for scripts not covered by a dedicated tool.",
    schema: z.object({ name: z.string().regex(/^[a-z0-9_]+$/).max(64), data: z.record(z.string(), z.unknown()).optional() }),
    scopeKey: ({ name }) => (typeof name === "string" ? { kind: "script", id: name } : undefined),
    run: ({ name, data }, by) => run("mcp.ha_script", name as string, JSON.stringify(data ?? {}), by, () => ha.runScript(name as string, (data as Record<string, unknown>) ?? {})),
  },
  {
    name: "desk_display_message",
    description: "Show a short title + body on the ESP32 OLED desk display for a few seconds.",
    schema: z.object({ title: z.string().max(24), body: z.string().max(120), seconds: z.number().int().min(2).max(60).default(10), node: z.string().default("desk") }),
    run: ({ title, body, seconds, node }, by) =>
      run("mcp.oled", node as string, title as string, by, async () => { showMessage(node as string, title as string, body as string, seconds as number); }),
  },
  {
    name: "door_state",
    description: "Intercom/door state: is someone ringing, last open, auto-open armed.",
    schema: z.object({}),
    readOnly: true,
    run: async () => ({ ok: true, ...intercomState() }),
  },
  {
    name: "door_open",
    description: "Open the building door via the intercom (buzz in). DESTRUCTIVE: physically opens the door. Only when the user explicitly asks.",
    schema: z.object({}),
    destructive: true,
    run: (_a, by) => run("mcp.door_open", "intercom", by, by, async () => {
      const r = await openDoor(by);
      if (!r.ok) throw new Error(r.error ?? "open failed");
    }),
  },
  {
    name: "door_auto_open",
    description: "Arm auto-open for the next ring for N minutes (courier coming), or ignore the current ring (minutes=0).",
    schema: z.object({ minutes: z.number().int().min(0).max(120) }),
    destructive: true,
    run: ({ minutes }, by) => run("mcp.door_arm", "intercom", `${minutes}m`, by, async () => {
      if ((minutes as number) === 0) return ignoreCall(by);
      return armAutoOpen(minutes as number, by);
    }),
  },
  {
    name: "pc_action",
    description: `Run a named action on the Windows PC (no arbitrary shell). Actions: ${PC_ACTIONS.join(", ")}. 'volume' needs value 0-100. lock/sleep/restart_vmui are destructive (interrupt the user's session).`,
    schema: z.object({ action: z.enum(PC_ACTIONS), value: z.number().int().min(0).max(100).optional() }),
    destructive: true,
    scopeKey: ({ action }) => (typeof action === "string" ? { kind: "pc", id: action } : undefined),
    run: ({ action, value }, by) =>
      run("mcp.pc", action as string, value !== undefined ? String(value) : "", by, async () => {
        if ((action as string) === "volume" && value === undefined) throw new Error("volume needs value 0-100");
        const out = await pcAction(action as string, value as number | undefined);
        return { output: out, destructive: PC_DESTRUCTIVE.has(action as string) };
      }),
  },
  {
    name: "pc_wake",
    description: "Wake the Windows PC (Dragos, i9-14900K) over the LAN with a Wake-on-LAN magic packet, or just report whether it is up. Use before pc_action / vm_* when the PC is off.",
    schema: z.object({ check_only: z.boolean().optional() }),
    run: async ({ check_only }, by) => {
      const t = pcTarget();
      if (!t) return { ok: false, error: "PC_WOL_MAC not configured" };
      const up = await pcIsUp(t.ip);
      if (check_only) return { ok: true, up, ip: t.ip };
      const r = await wakePc(`mcp:${by}`);
      return r.ok ? { ok: true, up, sent: !r.alreadyUp, hint: r.alreadyUp ? "PC already up" : "magic packet sent; allow 30-60 s for boot" } : r;
    },
  },
  {
    name: "vm_list",
    description: "List virtual machines known to vmui (Hyper-V dev fleet, macOS/Ubuntu/Windows local VMs, Home Assistant appliance, cloud) with id, name, provider and state.",
    schema: z.object({}),
    readOnly: true,
    run: async () => {
      const rows = await db.select({ id: instances.id, name: instances.name, state: instances.state, provider: instances.provider, region: instances.region }).from(instances);
      return { ok: true, vms: rows };
    },
  },
  {
    name: "vm_sync",
    description: "Refresh the VM list from the hypervisor/cloud (Hyper-V and WSL VMs on the PC are reached over SSH). Pass accountId from vm_list, or omit to sync every account. Slow: up to ~10 s per account.",
    schema: z.object({ accountId: z.string().min(1).optional() }),
    // vm_sync has no VM id; the `vm` limit is matched against the accountId instead,
    // and an unscoped call (sync everything) is refused for keys with a vmIds list.
    scopeKey: ({ accountId }) => ({ kind: "vm", id: typeof accountId === "string" ? accountId : "*" }),
    run: async ({ accountId }) => {
      const ids = accountId ? [accountId as string] : (await db.query.cloudAccounts.findMany({ columns: { id: true } })).map((a) => a.id);
      const results: Array<{ accountId: string; count?: number; error?: string }> = [];
      for (const id of ids) {
        try {
          results.push({ accountId: id, count: (await syncAccountInstances(id)).count });
        } catch (e) {
          results.push({ accountId: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const failed = results.filter((r) => r.error);
      if (failed.length) return { ok: false, error: failed.map((r) => `${r.accountId}: ${r.error}`).join("; ") };
      return { ok: true, results };
    },
  },
  {
    name: "vm_action",
    description: "start / stop / reboot / terminate a VM by id (from vm_list). stop/reboot/terminate are destructive.",
    schema: z.object({ id: z.string().min(1), action: z.enum(["start", "stop", "reboot", "terminate"]) }),
    destructive: true,
    scopeKey: ({ id }) => (typeof id === "string" ? { kind: "vm", id } : undefined),
    run: ({ id, action }, by) =>
      run("mcp.vm", id as string, action as string, by, async () => {
        const row = await db.query.instances.findFirst({ where: eq(instances.id, id as string) });
        if (!row) throw new Error("VM not found");
        const r = await executeInstanceAction(action as "start" | "stop" | "reboot" | "terminate", { accountId: row.accountId, region: row.region, providerInstanceId: row.providerInstanceId });
        if (!r.ok) throw new Error(r.error);
      }),
  },
  {
    name: "codai_provision_environment",
    description:
      "Turn a VM (id from vm_list; Linux/macOS with a public address and an account probe SSH key) into a codai Environment via the BYO path: ensures a codai project, creates the environment, mints a one-time enrol token and runs the codaid installer over SSH, then waits up to 5 min for enrolment. Requires the codai API key under Settings → Integrations. Not destructive: nothing on the VM is removed; re-running on a linked VM reuses its environment. Slow (1–6 min).",
    schema: z.object({
      instance_id: z.string().min(1),
      environment_name: z.string().trim().min(1).max(80),
      project_id: z.string().uuid().optional(),
      project_name: z.string().trim().min(1).max(80).optional(),
    }),
    destructive: false,
    scopeKey: ({ instance_id }) => (typeof instance_id === "string" ? { kind: "vm", id: instance_id } : undefined),
    run: async ({ instance_id, environment_name, project_id, project_name }, by) => {
      try {
        const lines: string[] = [];
        const r = await provisionCodaiEnvironment(
          { instanceId: instance_id as string, environmentName: environment_name as string, projectId: project_id as string | undefined, projectName: (project_name as string | undefined) ?? (environment_name as string) },
          (ev) => {
            if (ev.type === "line" || ev.type === "step") lines.push(ev.type === "step" ? `▸ ${ev.message}` : ev.text);
          },
          { by },
        );
        return { ok: true, environment_id: r.environmentId, project_id: r.projectId, slug: r.slug, state: r.state, install_exit_code: r.installExitCode, log_tail: lines.slice(-30) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: "codai_environment_status",
    description: "Whether a VM (id from vm_list) is linked to a codai Environment and its current state (pending / enrolling / running / stopped / error). Reads codai live when configured; falls back to the last cached state.",
    schema: z.object({ instance_id: z.string().min(1) }),
    readOnly: true,
    scopeKey: ({ instance_id }) => (typeof instance_id === "string" ? { kind: "vm", id: instance_id } : undefined),
    run: async ({ instance_id }) => {
      const link = await getCodaiLink(instance_id as string);
      if (!link) return { ok: true, linked: false };
      try {
        const live = await refreshCodaiStatus(instance_id as string);
        return { ok: true, linked: true, ...(live ?? {}), cached: false };
      } catch (e) {
        return { ok: true, linked: true, environmentId: link.environmentId, projectId: link.projectId, slug: link.slug, state: link.lastStatus, cached: true, warning: e instanceof Error ? e.message : String(e) };
      }
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
