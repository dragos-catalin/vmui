import { copilotEventSchema, currentSignal, inQuietHours, loadCopilotSignals, setSignal, type CopilotEvent } from "@/lib/copilot/signals";
import { stripFx } from "@/lib/copilot/strip-fx";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { pushActivity } from "@/lib/esp/activity";
import { espAuthorized } from "@/lib/esp/auth";
import { listNodes, showMessage } from "@/lib/esp/gallery";
import { ambilightStatus } from "@/lib/home/ambilight-status";
import { ha } from "@/lib/home/ha-client";
import { dismissByTag, notify } from "@/lib/notify";
import { agentSessions } from "@/lib/turzx/feeds";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// POST /api/copilot/event?k=<ESP_DISPLAY_TOKEN>   body: { event, text?, session?, source? }
// DELETE /api/copilot/event?k=…&session=…          cancel an active `ask` (next tool call)
// GET  /api/copilot/event?k=…                       current state (turzx polls via /api/turzx/state)
//
// Fired by ~/.copilot/hooks/copilot-signal.ps1. Each event fans out to the
// room light (HA script), the turzx desk screen (card) and the ESP32 OLED
// (message + activity line). Everything is best-effort: a dead HA must
// never make a hook fail.

const HA_SCRIPT: Record<CopilotEvent, string> = {
  ask: "copilot_ask",
  done: "copilot_done",
  blocked: "copilot_blocked",
  failed: "copilot_failed",
};
const TITLE: Record<CopilotEvent, string> = { ask: "Copilot asteapta", done: "Copilot gata", blocked: "Comanda blocata", failed: "A esuat" };
const PHONE_TITLE: Record<CopilotEvent, string> = { ask: "Copilot așteaptă răspunsul tău", done: "Copilot a terminat tura", blocked: "Comandă blocată de guard", failed: "Build / test eșuat" };
const CARD_ICON: Record<CopilotEvent, string> = { ask: "message-circle-question", done: "badge-check", blocked: "shield-alert", failed: "octagon-alert" };

/** One card per session: same `tag` so a later event replaces the earlier
 *  one instead of stacking, and the cancel path clears it. */
function phoneTag(session: string) {
  return `copilot-${session || "any"}`;
}

/** Rich card in the vmui notification centre (phone app, desktop, web); falls
 *  back to the HA Companion app by itself when no device acks. Tapping opens
 *  the mirrored codai session so the prompt can be answered from the phone. */
async function phonePush(event: CopilotEvent, p: { color: string }, text: string, session: string, source: string, project: string, chat: string) {
  const subtitle = [project, chat].filter(Boolean).join(" · ");
  const message = text || (event === "ask" ? "Deschide VS Code și răspunde la întrebare." : event === "done" ? "Poți verifica rezultatul." : source);
  const url = session ? `codai://session/${session}` : "codai://new";
  await notify({
    kind: "copilot",
    tag: phoneTag(session),
    title: PHONE_TITLE[event],
    body: message,
    subtitle: subtitle || source,
    color: p.color,
    icon: CARD_ICON[event],
    priority: event === "ask" ? "high" : event === "done" ? "default" : "high",
    // an `ask` stays until answered (cleared by tag on the next tool call)
    sticky: event === "ask",
    ttlSec: event === "ask" ? undefined : 600,
    url,
    actions: [{ id: "open", label: "Deschide în codai", style: "primary", url }],
    data: { event, session, project, chat, source },
  });
}

async function phoneClear(session: string) {
  await dismissByTag(phoneTag(session), "copilot");
}

/** One silent card that always shows who is working: one line per active
 *  session (repo · turns today · last request). Same tag so it updates in
 *  place; dismissed when nobody is active. */
async function phoneAgentsSummary() {
  const a = await agentSessions(30);
  if (!a) return;
  if (a.active.length === 0) {
    await dismissByTag("copilot-agents", "copilot");
    return;
  }
  const lines = a.active.slice(0, 6).map((s) => `• ${s.repo}${s.profile !== "default" ? ` (${s.profile})` : ""} · ${s.turnsToday} ture${s.lastUser ? ` — ${s.lastUser.slice(0, 60)}` : ""}`);
  await notify({
    kind: "agents",
    tag: "copilot-agents",
    title: `${a.active.length} ${a.active.length === 1 ? "agent lucrează" : "agenți lucrează"} · ${a.turnsToday} ture azi`,
    body: lines.join("\n"),
    subtitle: `${a.sessionsToday} sesiuni azi`,
    priority: "low",
    sticky: true,
    ttlSec: 3600,
    noFallback: true,
    url: "codai://new",
    data: { active: a.active.map((s) => ({ repo: s.repo, profile: s.profile, turnsToday: s.turnsToday })) },
  });
}

export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  return NextResponse.json({ signal: currentSignal() }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const cur = currentSignal();
  const session = new URL(req.url).searchParams.get("session") ?? "";
  if (cur?.active && (!session || !cur.session || cur.session === session)) {
    setSignal({ ...cur, active: false });
    const s = await loadCopilotSignals();
    if (s.patterns.ask.strip) void stripFx("clear");
    if (s.patterns.ask.phone) phoneClear(cur.session).catch(() => undefined);
    if (s.patterns.ask.light && s.lights.length) {
      try {
        // script.turn_on returns as soon as the run starts; the direct service
        // form waits for completion, and copilot_ask never completes on its own.
        await ha.callService("script", "turn_on", { entity_id: "script.copilot_clear", variables: { lights: s.lights } });
      } catch {
        // HA down: nothing to clear
      }
    }
    return NextResponse.json({ cancelled: true });
  }
  return NextResponse.json({ cancelled: false });
}

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const parsed = copilotEventSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  const { event, text, session, source, project, chat } = parsed.data;
  const s = await loadCopilotSignals();
  const p = s.patterns[event];
  const now = Date.now();
  setSignal({ id: `${now}|${event}|${session}`, at: now, event, text, source, session, project, chat, active: event === "ask" });
  const where = [project, chat].filter(Boolean).join(" · ");
  const out: Record<string, unknown> = { event, light: false, strip: false, turzx: p.turzx, esp: false };
  if (!s.enabled || !p.enabled) return NextResponse.json({ ...out, skipped: "disabled" });

  const quiet = inQuietHours(s);
  // The strip sits behind the monitor and is already lit in a film, so it is
  // not muted by movie mode; only quiet hours silence it.
  if (p.strip && !quiet) out.strip = await stripFx(event, p.color);
  let movie = false;
  if (s.muteInMovie && p.light) {
    try {
      const h = (await ha.states()).find((x) => x.entity_id === "light.hyperhdr");
      movie = ambilightStatus(h) === "movie";
    } catch {
      // HA down -> no light anyway
    }
  }
  if (p.light && s.lights.length && !quiet && !movie) {
    try {
      // Snapshot "before" only when no alert is running (the script checks),
      // and wait for it: the direct service form blocks until it completes.
      await ha.callService("script", "copilot_snapshot", { lights: s.lights });
      await ha.callService("script", "turn_on", { entity_id: `script.${HA_SCRIPT[event]}`, variables: { lights: s.lights, color: hexToRgb(p.color) } });
      out.light = true;
    } catch (e) {
      out.lightError = e instanceof Error ? e.message : String(e);
    }
  }
  if (p.esp) {
    for (const n of listNodes()) showMessage(n.name, TITLE[event], text || where || source, event === "ask" ? 10 : 8);
    pushActivity({ at: now, kind: "other", text: `${TITLE[event]}${where ? ` [${where.slice(0, 40)}]` : ""}${text ? `: ${text.slice(0, 40)}` : ""}` });
    out.esp = true;
  }
  if (p.phone && !quiet) {
    try {
      await phonePush(event, p, text, session, source, project, chat);
      out.phone = true;
    } catch (e) {
      out.phoneError = e instanceof Error ? e.message : String(e);
    }
  }
  phoneAgentsSummary().catch(() => undefined);
  await db.insert(auditLog).values({ accountId: "home", action: `copilot.${event}`, target: project || source, status: "ok", message: [chat, text].filter(Boolean).join(" — ").slice(0, 200) });
  return NextResponse.json({ ...out, quiet, movie });
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
