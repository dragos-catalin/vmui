import { z } from "zod";
import { STREAM_SCENES, type StreamSceneId } from "./catalog";

/**
 * Input contracts for the stream-effect MCP tools (scene_set, flash_color).
 * Kept free of server imports so the schemas and resolvers are unit-testable.
 */

const rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);

export const FLASH_COLORS = {
  red: [255, 0, 0],
  green: [0, 220, 60],
  blue: [0, 90, 255],
  cyan: [0, 220, 255],
  purple: [150, 0, 255],
  pink: [255, 0, 170],
  gold: [255, 180, 0],
  orange: [255, 100, 0],
  white: [255, 255, 255],
} as const satisfies Record<string, readonly [number, number, number]>;

export type FlashColorName = keyof typeof FLASH_COLORS;

const idempotencyKey = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe("Client-chosen id for this effect (e.g. the TikTok gift event id). A repeat within 60 s is a no-op.");

export const sceneSetSchema = z
  .object({
    scene: z.enum(STREAM_SCENES.map((s) => s.id) as [StreamSceneId, ...StreamSceneId[]]),
    durationSec: z.number().int().min(1).max(600).optional().describe("Seconds before the lights restore; capped per scene (scene_list maxDurationSec)."),
    idempotencyKey: idempotencyKey.optional(),
  })
  .superRefine((v, ctx) => {
    const scene = STREAM_SCENES.find((s) => s.id === v.scene);
    if (scene && scene.id !== "default" && v.durationSec !== undefined && v.durationSec > scene.maxDurationSec) {
      ctx.addIssue({ code: "custom", path: ["durationSec"], message: `must be <= ${scene.maxDurationSec} for ${scene.id}` });
    }
  });

export const flashColorSchema = z
  .object({
    rgb: rgb.optional().describe("[r,g,b] 0-255. Give either rgb or color."),
    color: z.enum(Object.keys(FLASH_COLORS) as [FlashColorName, ...FlashColorName[]]).optional(),
    count: z.number().int().min(1).max(5).default(1),
    durationMs: z.number().int().min(200).max(5000).default(600).describe("Length of each flash."),
    idempotencyKey: idempotencyKey.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.rgb === undefined) === (v.color === undefined)) {
      ctx.addIssue({ code: "custom", path: ["rgb"], message: "give exactly one of rgb or color" });
    }
  });

export type SceneSetArgs = z.infer<typeof sceneSetSchema>;
export type FlashColorArgs = z.infer<typeof flashColorSchema>;

export type ResolvedScene = { id: StreamSceneId; script: string; durationSec: number };

/** Clamp-free: a duration above the scene's cap is an input error the caller should see. */
export function resolveScene(args: Pick<SceneSetArgs, "scene" | "durationSec">): ResolvedScene {
  const scene = STREAM_SCENES.find((s) => s.id === args.scene);
  if (!scene) throw new Error(`Unknown scene ${args.scene}; call scene_list`);
  const script = scene.entity.replace(/^script\./, "");
  if (scene.id === "default") return { id: scene.id, script, durationSec: 0 };
  const durationSec = args.durationSec ?? scene.defaultDurationSec;
  if (durationSec > scene.maxDurationSec) throw new Error(`durationSec for ${scene.id} must be <= ${scene.maxDurationSec}`);
  return { id: scene.id, script, durationSec };
}

export function resolveFlashColor(args: Pick<FlashColorArgs, "rgb" | "color">): [number, number, number] {
  if (args.rgb && args.color) throw new Error("Give either rgb or color, not both");
  if (args.rgb) return [...args.rgb];
  if (args.color) return [...FLASH_COLORS[args.color]];
  throw new Error("flash_color needs rgb or color");
}

export function sceneScopeId(scene: unknown): string | undefined {
  return typeof scene === "string" ? `stream_scene_${scene}` : undefined;
}
