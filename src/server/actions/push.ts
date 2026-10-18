"use server";

import { getCurrentUser, requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLog, pushSubscriptions } from "@/lib/db/schema";
import { sendPush, vapidPublicKey, type PushTopic } from "@/lib/push";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const TOPICS = ["state", "builds", "alerts", "costs", "compliance"] as const;

const SubscribeSchema = z.object({
  endpoint: z.url(),
  p256dh: z.string().min(1),
  authKey: z.string().min(1),
  topics: z.array(z.enum(TOPICS)).min(1).default([...TOPICS]),
  userAgent: z.string().optional(),
});

export async function subscribePushAction(input: z.infer<typeof SubscribeSchema>) {
  await requireRole("viewer");
  const v = SubscribeSchema.parse(input);
  const me = await getCurrentUser();
  const existing = db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, v.endpoint))
    .get();
  if (existing) {
    db.update(pushSubscriptions)
      .set({
        p256dh: v.p256dh,
        authKey: v.authKey,
        topics: v.topics.join(","),
        lastSeenAt: new Date(),
      })
      .where(eq(pushSubscriptions.id, existing.id))
      .run();
    return { ok: true as const, id: existing.id };
  }
  const id = randomUUID();
  db.insert(pushSubscriptions)
    .values({
      id,
      endpoint: v.endpoint,
      p256dh: v.p256dh,
      authKey: v.authKey,
      topics: v.topics.join(","),
      userAgent: v.userAgent ?? null,
      userId: me?.id ?? null,
    })
    .run();
  db.insert(auditLog)
    .values({ action: "push.subscribe", target: id, status: "ok" })
    .run();
  return { ok: true as const, id };
}

export async function unsubscribePushAction(input: { endpoint: string }) {
  await requireRole("viewer");
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint)).run();
  return { ok: true as const };
}

export async function testPushAction(input: { topics: PushTopic[] }) {
  await requireRole("viewer");
  const r = await sendPush((input.topics[0] ?? "state") as PushTopic, {
    title: "Vatra test",
    body: "If you see this, push notifications are working.",
    url: "/",
    tag: "test",
  });
  return { ok: true as const, ...r };
}

export async function getVapidPublicKeyAction() {
  return { ok: true as const, key: vapidPublicKey() };
}
