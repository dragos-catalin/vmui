"use server";

import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { runAgent, checkOllama, type ChatMessage } from "@/lib/ai-agent";
import { hasAiConsent } from "@/lib/ai/consent";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

const schema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    tool_name: z.string().optional(),
  })).max(20).optional(),
});

export async function askAgentAction(input: { message: string; history?: ChatMessage[] }) {
  const me = await requireRole("viewer");
  // AI Act art. 50(1) + GDPR: nothing reaches the model before this user accepted the disclosure.
  if (!(await hasAiConsent(me?.id))) return { ok: false as const, error: "ai_consent_required" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "invalid" };
  try {
    const r = await runAgent(parsed.data.message, (parsed.data.history ?? []) as ChatMessage[]);
    db.insert(auditLog).values({
      action: "ai.chat",
      target: "agent",
      status: "ok",
      message: `tools: ${r.toolsUsed.join(",") || "(none)"}`,
    }).run();
    return { ok: true as const, messages: r.messages, toolsUsed: r.toolsUsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.insert(auditLog).values({ action: "ai.chat", target: "agent", status: "error", message: msg }).run();
    return { ok: false as const, error: msg };
  }
}

export async function checkOllamaAction() {
  await requireRole("viewer");
  return await checkOllama();
}
