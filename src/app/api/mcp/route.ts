import "server-only";

import { requireApiRole, validateApiKey } from "@/lib/api-auth";
import { argsAllowed, toolAllowed, type ApiKeyScopes } from "@/lib/api-key-scopes";
import { effectLimiter } from "@/lib/mcp/effect-limiter";
import { TOOL_BY_NAME, TOOLS } from "@/lib/mcp/tools";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

/**
 * MCP server (Streamable HTTP, stateless, JSON responses) exposing this house
 * and this PC as named tools to codai phone/desktop over the tailnet.
 *
 * Auth: bearer `vmui_*` API key with the operator role (Settings -> API keys).
 * A key may carry scopes (tool allow-list + per-argument limits); tools/list
 * only advertises what the key may call and tools/call refuses the rest.
 * Each call is audit-logged under accountId "mcp". Tools that interrupt the
 * user or act on the physical world carry `destructiveHint` so the client
 * shows an ask-card first.
 */

export const dynamic = "force-dynamic";

const PROTOCOL = "2025-03-26";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

function ok(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolList(scopes: ApiKeyScopes | null) {
  return TOOLS.filter((t) => toolAllowed(t, scopes)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema, { target: "openapi-3.0", reused: "inline", io: "input" }),
    annotations: {
      title: t.name.replace(/_/g, " "),
      readOnlyHint: t.readOnly ?? false,
      destructiveHint: t.destructive ?? false,
      idempotentHint: t.readOnly ?? false,
      openWorldHint: false,
    },
  }));
}

const NOT_PERMITTED = "tool not permitted for this key";

function text(r: unknown, isError: boolean) {
  return { isError, content: [{ type: "text", text: JSON.stringify(r) }] };
}

async function handle(msg: Rpc, by: string, keyId: string, scopes: ApiKeyScopes | null): Promise<unknown | null> {
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vmui-home", version: "1.0.0" },
        instructions:
          "Tools control Dragos's home (Home Assistant: lights, AC, Nest Hub, ambilight, door) and his Windows PC. " +
          "The tool list reflects this key's scope: tools or targets (VMs, entities, PC actions, scripts) outside it are refused. " +
          "Call home_devices/home_state before guessing entity ids. Ask before destructive tools (door_open, pc_action lock/sleep, vm stop/terminate). " +
          "Light effects (scene_set, flash_color, notify_flash) are rate-limited per key: a limited call answers {limited:true, retryAfterMs} and still plays once the window ends (last call wins) — it is not an error.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: toolList(scopes) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return err(msg.id, -32602, `Unknown tool ${name}`);
      if (!toolAllowed(tool, scopes)) return ok(msg.id, { isError: true, content: [{ type: "text", text: NOT_PERMITTED }] });
      const parsed = tool.schema.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }] });
      }
      if (!argsAllowed(tool.scopeKey?.(parsed.data), scopes)) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: NOT_PERMITTED }] });
      }
      if (tool.effect && !tool.effect.bypass?.(parsed.data)) {
        const data = parsed.data as Record<string, unknown>;
        const idem = typeof data.idempotencyKey === "string" ? data.idempotencyKey : undefined;
        const s = await effectLimiter().submit(keyId, tool.effect.kind, idem ? `${tool.name}:${idem}` : undefined, () => tool.run(data, by));
        const first = s.status === "duplicate" ? s.first : s;
        if (first.status === "limited") {
          return ok(msg.id, text({ ok: true, limited: true, retryAfterMs: first.retryAfterMs, queued: true, ...(s.status === "duplicate" ? { duplicate: true } : {}) }, false));
        }
        const r = first.status === "ran" ? first.result : { ok: false as const, error: "unexpected limiter state" };
        return ok(msg.id, text(s.status === "duplicate" ? { ...r, duplicate: true } : r, !r.ok));
      }
      const r = await tool.run(parsed.data, by);
      return ok(msg.id, text(r, !r.ok));
    }
    default:
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(req: NextRequest) {
  const auth = requireApiRole(await validateApiKey(req), "operator");
  if (!auth.ok) return NextResponse.json(err(null, -32000, auth.error), { status: auth.status });
  const by = `mcp:${auth.keyId}`;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(err(null, -32700, "Parse error"), { status: 400 });
  }
  const msgs = (Array.isArray(body) ? body : [body]) as Rpc[];
  const out: unknown[] = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      out.push(err((m as Rpc | undefined)?.id ?? null, -32600, "Invalid request"));
      continue;
    }
    const r = await handle(m, by, auth.keyId, auth.scopes);
    if (r !== null) out.push(r);
  }
  if (out.length === 0) return new NextResponse(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? out : out[0]);
}

// Stateless server: no SSE stream to resume, no session to delete.
export function GET() {
  return NextResponse.json({ error: "SSE stream not supported; POST JSON-RPC" }, { status: 405 });
}
export function DELETE() {
  return new NextResponse(null, { status: 204 });
}
