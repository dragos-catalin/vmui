import "server-only";

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { AMBILIGHT_MODES } from "@/lib/home/catalog";
import { houseDevices, houseEntities } from "@/lib/home/house";
import { canControlAny, canControlEntity, type HomeActor } from "@/lib/home/access";
import { ha } from "@/lib/home/ha-client";
import { z } from "zod";

// One device-control implementation for every token surface (Nest Hub kiosk, /api/v1/app/control):
// same entity whitelist (only what the house renders), same room check, same audit row.

export const entityIdSchema = z
  .string()
  .regex(/^[a-z_]+\.[a-z0-9_]+$/)
  .refine((e) => e === "light.hyperhdr" || houseEntities().has(e), "unknown entity");

const rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);

export const controlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle"), entity: entityIdSchema, on: z.boolean() }),
  z.object({
    type: z.literal("light"),
    entity: entityIdSchema,
    rgb: rgb.optional(),
    brightnessPct: z.number().int().min(1).max(100).optional(),
    kelvin: z.number().int().min(1500).max(9000).optional(),
  }),
  z.object({
    type: z.literal("climate"),
    entity: entityIdSchema,
    hvacMode: z.enum(["off", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"]).optional(),
    temperature: z.number().min(16).max(30).optional(),
    fanMode: z.string().max(32).optional(),
  }),
  z.object({ type: z.literal("select"), entity: entityIdSchema, option: z.string().max(64) }),
  z.object({ type: z.literal("media"), entity: entityIdSchema, command: z.enum(["play_pause", "next_track", "previous_track", "volume_up", "volume_down", "volume_mute", "turn_on", "turn_off"]) }),
  z.object({ type: z.literal("ambilight"), mode: z.enum(["movie", "music", "off"]) }),
  z.object({ type: z.literal("script"), name: z.enum(["pc_wake", "movie_mode_on", "movie_mode_off", "music_mode"]) }),
]);
export type ControlCommand = z.infer<typeof controlCommandSchema>;

/** Entity commands need control of that entity's room; house-wide ones need control somewhere. */
export function mayControl(actor: HomeActor, c: ControlCommand): boolean {
  return "entity" in c ? canControlEntity(actor, c.entity) : canControlAny(actor);
}

const whiteOnly = (e: string) => houseDevices().some((d) => d.whiteOnly && d.entity === e);

/** Runs the command against Home Assistant and audits it. Throws on an HA failure (after auditing it). */
export async function runControl(c: ControlCommand, source: string): Promise<void> {
  const target = "entity" in c ? c.entity : c.type;
  try {
    switch (c.type) {
      case "toggle": {
        const domain = c.entity.split(".")[0] ?? "homeassistant";
        const svc = ["light", "switch", "fan", "media_player", "climate", "humidifier"].includes(domain) ? domain : "homeassistant";
        await ha.callService(svc, c.on ? "turn_on" : "turn_off", { entity_id: c.entity });
        break;
      }
      case "light": {
        if (c.rgb && whiteOnly(c.entity)) throw new Error("white-only light");
        const data: Record<string, unknown> = { entity_id: c.entity, transition: 0.4 };
        if (c.rgb) data.rgb_color = c.rgb;
        if (c.brightnessPct !== undefined) data.brightness_pct = c.brightnessPct;
        if (c.kelvin !== undefined) data.color_temp_kelvin = c.kelvin;
        await ha.callService("light", "turn_on", data);
        break;
      }
      case "climate":
        if (c.hvacMode) await ha.callService("climate", "set_hvac_mode", { entity_id: c.entity, hvac_mode: c.hvacMode });
        if (c.temperature !== undefined) await ha.callService("climate", "set_temperature", { entity_id: c.entity, temperature: c.temperature });
        if (c.fanMode) await ha.callService("climate", "set_fan_mode", { entity_id: c.entity, fan_mode: c.fanMode });
        break;
      case "select":
        await ha.callService("select", "select_option", { entity_id: c.entity, option: c.option });
        break;
      case "media": {
        const svc = c.command === "play_pause" ? "media_play_pause" : c.command === "next_track" ? "media_next_track" : c.command === "previous_track" ? "media_previous_track" : c.command;
        const data: Record<string, unknown> = { entity_id: c.entity };
        if (c.command === "volume_mute") data.is_volume_muted = true;
        await ha.callService("media_player", svc, data);
        break;
      }
      case "ambilight": {
        const m = AMBILIGHT_MODES.find((x) => x.id === c.mode);
        if (!m) throw new Error("unknown mode");
        await ha.runScript(m.script);
        break;
      }
      case "script":
        await ha.runScript(c.name);
        break;
    }
    await db.insert(auditLog).values({ accountId: "home", action: `${source}.${c.type}`, target, status: "ok", message: JSON.stringify(c).slice(0, 400) });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({ accountId: "home", action: `${source}.${c.type}`, target, status: "error", message: error });
    throw e;
  }
}
