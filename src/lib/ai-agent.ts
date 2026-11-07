import "server-only";
import { db } from "@/lib/db";
import { instances, auditLog, pricingCache } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { generateCostRecommendations } from "@/lib/cost-optimizer";

export const OLLAMA_URL = process.env.VMUI_OLLAMA_URL ?? "http://127.0.0.1:11434";
export const OLLAMA_MODEL = process.env.VMUI_OLLAMA_MODEL ?? "llama3.2";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
}

const TOOLS = {
  list_instances: async () => {
    const rows = await db.select().from(instances).limit(200);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      region: r.region,
      status: r.state,
      instanceType: r.instanceType,
    }));
  },
  recent_audit: async () => {
    return await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(50);
  },
  cost_summary: async () => {
    const rows = await db.select().from(pricingCache).limit(500);
    const total = rows.reduce((s, r) => s + (r.usdPerHour ?? 0) * 24 * 30, 0);
    return { sampledMonthlyUsd: total, sampledTypes: rows.length, note: "monthly burn projected from cached price catalog" };
  },
  recommendations: async () => {
    return await generateCostRecommendations();
  },
} as const;

type ToolName = keyof typeof TOOLS;

const TOOL_DESC = `Available tools (call with JSON line: {"tool":"<name>"}):
- list_instances: every VM across every cloud
- recent_audit: last 50 audit log entries
- cost_summary: total spend over last 30 days
- recommendations: cost optimizer suggestions (idle/rightsize/RI)`;

const SYSTEM = `You are vmui, the assistant for a local-first multi-cloud VM control plane.
You can call tools to inspect the user's infrastructure. Be terse, technical, and assume the user is a developer.
${TOOL_DESC}
When you want a tool, emit ONLY one line: {"tool":"<name>"} and nothing else. After receiving the tool result, write your final answer in markdown.`;

async function ollamaChat(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.tool_name ? `[tool:${m.tool_name}]\n${m.content}` : m.content })),
      stream: false,
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

function tryParseToolCall(text: string): ToolName | null {
  const m = text.trim().match(/\{\s*"tool"\s*:\s*"([a-z_]+)"\s*\}/);
  if (!m) return null;
  const name = m[1] as ToolName;
  if (name in TOOLS) return name;
  return null;
}

export async function runAgent(userMessage: string, history: ChatMessage[] = []): Promise<{ messages: ChatMessage[]; toolsUsed: string[] }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...history,
    { role: "user", content: userMessage },
  ];
  const toolsUsed: string[] = [];
  for (let i = 0; i < 4; i++) {
    const reply = await ollamaChat(messages);
    const tool = tryParseToolCall(reply);
    if (!tool) {
      messages.push({ role: "assistant", content: reply });
      return { messages: messages.slice(1), toolsUsed };
    }
    toolsUsed.push(tool);
    messages.push({ role: "assistant", content: reply });
    const result = await TOOLS[tool]();
    messages.push({ role: "tool", tool_name: tool, content: JSON.stringify(result, null, 2).slice(0, 8000) });
  }
  messages.push({ role: "assistant", content: "(tool budget exhausted)" });
  return { messages: messages.slice(1), toolsUsed };
}

export async function checkOllama(): Promise<{ ok: boolean; url: string; model: string; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, url: OLLAMA_URL, model: OLLAMA_MODEL, error: `HTTP ${res.status}` };
    return { ok: true, url: OLLAMA_URL, model: OLLAMA_MODEL };
  } catch (e) {
    return { ok: false, url: OLLAMA_URL, model: OLLAMA_MODEL, error: e instanceof Error ? e.message : String(e) };
  }
}
