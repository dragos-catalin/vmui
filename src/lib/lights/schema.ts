import { z } from "zod";
import { COLOR_ORDERS, TRANSPORTS } from "./model";

// Zod mirrors of lib/lights/model.ts, shared by the HTTP route, MCP tools and import.

const byte = z.number().int().min(0).max(255);
export const rgbSchema = z.tuple([byte, byte, byte]);

export const lightStateSchema = z.object({
  on: z.boolean(),
  rgb: rgbSchema.optional(),
  brightnessPct: z.number().int().min(0).max(100).optional(),
  kelvin: z.number().int().min(1000).max(10000).optional(),
  effect: z.string().min(1).max(80).optional(),
});

export const calibrationSchema = z.object({
  gamma: z.number().min(0.2).max(5).optional(),
  gains: z.tuple([z.number().min(0).max(2), z.number().min(0).max(2), z.number().min(0).max(2)]).optional(),
  briCap: z.number().min(0).max(1).optional(),
  briMin: z.number().min(0).max(1).optional(),
  colorOrder: z.enum(COLOR_ORDERS).optional(),
  kelvinOffset: z.number().int().min(-3000).max(3000).optional(),
});

export const capabilitiesSchema = z.object({
  onoff: z.literal(true).default(true),
  brightness: z.boolean().default(true),
  rgb: z.boolean().default(false),
  kelvin: z.tuple([z.number().int(), z.number().int()]).nullable().default(null),
  effects: z.array(z.string().max(80)).max(200).default([]),
  addressable: z.boolean().default(false),
  segments: z.boolean().default(false),
  ledCountConfig: z.boolean().default(false),
  whiteOnly: z.boolean().default(false),
});

export const targetSchema = z
  .string()
  .max(160)
  .refine((t) => t === "all" || /^(dev|seg|group|room):[A-Za-z0-9_.:-]+$/.test(t), "invalid target");

export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const deviceInputSchema = z.object({
  id: slugSchema.optional(),
  name: z.string().min(1).max(80),
  room: z.string().min(1).max(40).default("bedroom"),
  transport: z.enum(TRANSPORTS),
  address: z.string().min(1).max(120),
  protocol: z.string().max(20).nullish(),
  haEntity: z.string().regex(/^light\.[a-z0-9_]+$/).nullish(),
  capabilities: capabilitiesSchema.default(capabilitiesSchema.parse({})),
  calibration: calibrationSchema.default({}),
  ledCount: z.number().int().min(1).max(5000).default(1),
  fingerprint: z.string().max(120).nullish(),
  discoveredVia: z.enum(["ha", "ble_scan", "manual", "seed"]).default("manual"),
  enabled: z.boolean().default(true),
});
export type DeviceInput = z.infer<typeof deviceInputSchema>;

export const devicePatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  room: z.string().min(1).max(40).optional(),
  enabled: z.boolean().optional(),
  calibration: calibrationSchema.optional(),
  ledCount: z.number().int().min(1).max(5000).optional(),
  haEntity: z.string().regex(/^light\.[a-z0-9_]+$/).nullable().optional(),
  capabilities: capabilitiesSchema.partial().optional(),
});
export type DevicePatch = z.infer<typeof devicePatchSchema>;

export const segmentPatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  ledCount: z.number().int().min(1).max(5000).optional(),
  reverse: z.boolean().optional(),
  calibration: calibrationSchema.optional(),
});
export type SegmentPatch = z.infer<typeof segmentPatchSchema>;

export const sceneEntrySchema = z.object({ target: targetSchema, state: lightStateSchema });

export const discoveredItemSchema = z.object({
  mac: z.string().regex(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/),
  name: z.string().max(80).default(""),
  rssi: z.number().int().min(-130).max(20).nullish(),
  protocol: z.string().max(20).nullish(),
});
export type DiscoveredItem = z.infer<typeof discoveredItemSchema>;

export const registryExportSchema = z.object({
  version: z.literal(1),
  devices: z.array(
    deviceInputSchema.extend({
      id: slugSchema,
      segments: z
        .array(z.object({ id: z.string().min(1).max(80), ord: z.number().int().min(0), name: z.string().min(1).max(60), ledCount: z.number().int().min(1).max(5000), reverse: z.boolean().default(false), calibration: calibrationSchema.default({}) }))
        .default([]),
    }),
  ),
  groups: z.array(z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(80), kind: z.string().max(20).default("custom"), members: z.array(targetSchema).default([]) })).default([]),
  scenes: z.array(z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(80), entries: z.array(sceneEntrySchema) })).default([]),
  profiles: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(80), calibration: calibrationSchema, active: z.boolean().default(false) })).default([]),
});
export type RegistryExport = z.infer<typeof registryExportSchema>;
