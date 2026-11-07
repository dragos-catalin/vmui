import { z } from "zod";

// POST /api/devices/pair body. Order matters: z.union returns the first match and z.object strips
// unknown keys, so the bare {name, platform} branch must come last or it swallows invite and
// e-mail sign-ins as pending approval requests.
export const pairBody = z.union([
  // QR pairing: a one-time invite minted by a signed-in member (POST /api/devices/pair/invite)
  z.object({ name: z.string().min(1).max(64), platform: z.string().min(1).max(32), invite: z.string().min(16).max(64) }),
  z.object({ name: z.string().min(1).max(64), platform: z.string().min(1).max(32), email: z.email(), password: z.string().min(1) }),
  z.object({ name: z.string().min(1).max(64), platform: z.string().min(1).max(32) }),
]);