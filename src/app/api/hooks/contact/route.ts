import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { ha } from "@/lib/home/ha-client";
import { credential } from "@/lib/home/credentials";
import { claimReplayKeys, handleContactHook, type ContactPayload } from "@/lib/hooks/contact";
import { notify } from "@/lib/notify";
import { msg } from "@/lib/notify/i18n";
import { rateLimit } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/hooks/contact — public through the Tailscale Funnel on homepi
// (https://homepi.taild1532d.ts.net/hooks/contact). See lib/hooks/contact.ts
// for the signature scheme and docs/home-assistant.md "Contact form" for ops.

const RATE_PER_MIN = 10;

async function deliver(p: ContactPayload & { preview: string; nonce: string }): Promise<void> {
  const reply = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(`Re: ${p.subject ?? "dragoscatalin.ro"}`)}`;
  await notify({
    kind: "contact",
    tag: `contact-${p.nonce}`,
    title: msg("cards.contact.title", { name: p.name.slice(0, 80) }),
    subtitle: p.subject ? `${p.subject.slice(0, 120)} · ${p.email}` : p.email,
    body: p.preview,
    priority: "high",
    ttlSec: 7 * 86400,
    url: reply,
    actions: [{ id: "reply", label: msg("cards.contact.reply"), style: "primary", url: reply }],
    data: { email: p.email, locale: p.locale, receivedAt: p.receivedAt, source: "dragoscatalin.ro" },
  });
  // body is never logged: only that a message arrived and how long it was
  await db.insert(auditLog).values({ accountId: "notify", action: "contact.received", target: p.nonce, status: "ok", message: `locale=${p.locale} chars=${p.message.length}` });
  // optional light flash: HA automation `contact_flash` (pi/ha-packages/vmui_contact.yaml) listens for this event
  if (ha.configured()) void ha.fireEvent("vmui_notify", { kind: "contact" }).catch(() => undefined);
}

export async function POST(req: NextRequest) {
  return handleContactHook(req, {
    secret: () => credential("CONTACT_HOOK_SECRET"),
    nowMs: () => Date.now(),
    limit: (source) => rateLimit(`hook-contact:${source}`, RATE_PER_MIN, 60).ok,
    claim: (keys, nowSec) => claimReplayKeys(db, keys, nowSec),
    deliver,
  });
}
