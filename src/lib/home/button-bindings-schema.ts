import { z } from "zod";

/** Shared (client + server) shapes for the desk-button gesture table. */

export const GESTURES = ["1", "2", "3", "4", "5", "long"] as const;
export type Gesture = (typeof GESTURES)[number];

export const buttonActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("water_add"), ml: z.number().int().min(10).max(2000) }),
  z.object({ type: z.literal("water_undo") }),
  z.object({ type: z.literal("ha_script"), script: z.string().regex(/^[a-z0-9_]{1,64}$/) }),
  z.object({ type: z.literal("ha_service"), service: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/), entityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).optional() }),
  z.object({ type: z.literal("intercom_open") }),
  z.object({ type: z.literal("intercom_arm"), minutes: z.number().int().min(1).max(240) }),
  z.object({ type: z.literal("turzx_next") }),
  z.object({ type: z.literal("turzx_pause") }),
  z.object({ type: z.literal("ambilight_movie") }),
  z.object({ type: z.literal("pc_wake") }),
]);
export type ButtonAction = z.infer<typeof buttonActionSchema>;

export const buttonBindingsSchema = z.object({
  version: z.literal(1),
  gestures: z.partialRecord(z.enum(GESTURES), buttonActionSchema),
});
export type ButtonBindings = z.infer<typeof buttonBindingsSchema>;

export const BUTTON_DEFAULTS: ButtonBindings = {
  version: 1,
  gestures: {
    "1": { type: "water_add", ml: 250 },
    "2": { type: "water_add", ml: 100 },
    "3": { type: "turzx_next" },
    "4": { type: "ambilight_movie" },
    "5": { type: "intercom_arm", minutes: 45 },
    long: { type: "water_undo" },
  },
};

/** Language-neutral one-liner for the audit log (UI labels come from messages/homeCards). */
export function describeAction(a: ButtonAction): string {
  switch (a.type) {
    case "none": return "none";
    case "water_add": return `water +${a.ml} ml`;
    case "water_undo": return "water undo";
    case "ha_script": return `HA script ${a.script}`;
    case "ha_service": return `${a.service}${a.entityId ? ` → ${a.entityId}` : ""}`;
    case "intercom_open": return "intercom open";
    case "intercom_arm": return `intercom auto-open ${a.minutes} min`;
    case "turzx_next": return "turzx next view";
    case "turzx_pause": return "turzx pause/resume";
    case "ambilight_movie": return "ambilight movie mode";
    case "pc_wake": return "PC wake-on-lan";
  }
}
