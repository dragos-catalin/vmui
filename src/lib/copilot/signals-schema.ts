import { z } from "zod";

/** Agent-harness events that get a physical signal: room light pattern,
 *  turzx card, ESP32 message. Fired by ~/.copilot/hooks via
 *  POST /api/copilot/event; cleared by the next tool call.
 *  Safe for client components (no server-only imports). */
export const COPILOT_EVENTS = ["ask", "done", "blocked", "failed"] as const;
export type CopilotEvent = (typeof COPILOT_EVENTS)[number];

export const copilotEventSchema = z.object({
  event: z.enum(COPILOT_EVENTS),
  /** Short line for the screens, e.g. the question header or the guard reason. */
  text: z.string().max(240).default(""),
  /** Copilot session id, used so a later tool call in the SAME session cancels the alert. */
  session: z.string().max(120).default(""),
  /** Which harness / workspace, for the card badge. */
  source: z.string().max(60).default("copilot"),
  /** Workspace folder name, as the VS Code taskbar title shows it. */
  project: z.string().max(80).default(""),
  /** Chat tab title of the session that raised the event. */
  chat: z.string().max(160).default(""),
});
export type CopilotEventInput = z.infer<typeof copilotEventSchema>;

const patternSchema = z.object({
  enabled: z.boolean(),
  light: z.boolean(),
  /** Per-LED animation on the DX Light strip behind the monitor (ambilight/notify_fx.py). */
  strip: z.boolean().default(true),
  turzx: z.boolean(),
  esp: z.boolean(),
  /** Rich push to the phone via the HA companion app (notify.mobile_app_*). */
  phone: z.boolean().default(true),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const copilotSignalsSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  /** Do not disturb a film: skip the light when HyperHDR's grabber is on. */
  muteInMovie: z.boolean(),
  quietFrom: z.string().regex(/^\d{2}:\d{2}$/),
  quietTo: z.string().regex(/^\d{2}:\d{2}$/),
  /** Which HA light entities carry the pattern. */
  lights: z.array(z.string()),
  /** HA notify service for the phone, e.g. `mobile_app_pixel_9`. Empty = the household owner phone. */
  phoneNotify: z.string().max(80).default(""),
  patterns: z.object({
    ask: patternSchema,
    done: patternSchema,
    blocked: patternSchema,
    failed: patternSchema,
  }),
});
export type CopilotSignals = z.infer<typeof copilotSignalsSchema>;

export const COPILOT_SIGNALS_DEFAULTS: CopilotSignals = {
  version: 1,
  enabled: true,
  muteInMovie: true,
  quietFrom: "23:30",
  quietTo: "07:30",
  lights: [],
  phoneNotify: "",
  patterns: {
    ask: { enabled: true, light: true, strip: true, turzx: true, esp: true, phone: true, color: "#ff5a1f" },
    done: { enabled: true, light: true, strip: true, turzx: true, esp: true, phone: true, color: "#2ecc71" },
    blocked: { enabled: true, light: true, strip: true, turzx: true, esp: false, phone: true, color: "#ff2d2d" },
    failed: { enabled: true, light: true, strip: true, turzx: true, esp: true, phone: true, color: "#ffc400" },
  },
};
