"use server";

import "server-only";

import { OLLAMA_MODEL, OLLAMA_URL } from "@/lib/ai-agent";
import { getAiConsent, hasAiConsent, setAiConsent, AI_CONSENT_VERSION } from "@/lib/ai/consent";
import { getCurrentUser, requireRole } from "@/lib/auth";
import { credential } from "@/lib/home/credentials";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { z } from "zod";

/** Where the hub's AI traffic goes, for the disclosure: the chat model and (when a key is set) the coach. */
function aiRoute(): string {
  let host = OLLAMA_URL;
  try {
    host = new URL(OLLAMA_URL).host;
  } catch {}
  const local = /^(127\.|localhost|\[::1\])/.test(host);
  const chat = `Ollama ${OLLAMA_MODEL} @ ${host}${local ? " (this machine)" : ""}`;
  return credential("CODAI_API_KEY") ? `${chat}; nutrition coach: codai gateway (ai.codai.ro, model codai-fast)` : chat;
}

export async function getAiConsentAction(): Promise<{ granted: boolean; version: number; at: number | null; route: string }> {
  const me = await requireRole("viewer");
  const c = await getAiConsent(me?.id);
  return { granted: await hasAiConsent(me?.id), version: AI_CONSENT_VERSION, at: c?.at ?? null, route: aiRoute() };
}

export async function setAiConsentAction(input: { granted: boolean }): Promise<{ ok: true; granted: boolean } | { ok: false; error: string }> {
  const parsed = z.object({ granted: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "common.error" };
  await requireRole("viewer");
  const me = await getCurrentUser();
  await setAiConsent(me?.id, parsed.data.granted);
  await db.insert(auditLog).values({ action: parsed.data.granted ? "ai.consent.grant" : "ai.consent.revoke", target: me?.id ?? "solo", status: "ok", message: `v${AI_CONSENT_VERSION}` });
  return { ok: true, granted: parsed.data.granted };
}
