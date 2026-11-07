"use server";

import { err, ok, type ActionResult } from "@/lib/action-result";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { isDemo } from "@/lib/demo/mode";
import { HomeAccessError, requireOwner } from "@/lib/home/access";
import { writeIntegrations } from "@/lib/integrations";
import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export type VatraCloudView = {
  hubId: string;
  domain: string;
  publicUrl: string;
  remote: boolean;
  push: boolean;
  state: "off" | "connecting" | "online" | "error";
  since: number;
  lastError: string | null;
  certNotAfter: number | null;
  certRenewAt: number | null;
  certError: string | null;
  clients: number;
};

async function view(): Promise<VatraCloudView> {
  const { hubIdentity, cloudDomain } = await import("@/lib/cloud/identity");
  const { cloudStatus, pushEnabled, remoteEnabled } = await import("@/lib/cloud");
  const { readCertState } = await import("@/lib/cloud/acme");
  const { hubId } = hubIdentity();
  const domain = cloudDomain();
  const s = cloudStatus();
  const cert = readCertState();
  return {
    hubId,
    domain,
    publicUrl: `https://${hubId}.${domain}`,
    remote: remoteEnabled(),
    push: pushEnabled(),
    state: s.state,
    since: s.since,
    lastError: s.lastError,
    certNotAfter: cert?.notAfter || s.certNotAfter,
    certRenewAt: cert?.renewAt || s.certRenewAt,
    certError: cert?.lastError ?? s.certError,
    clients: s.clients,
  };
}

const audit = (action: string, status: "ok" | "error", message: string) =>
  db.insert(auditLog).values({ accountId: "home", action, target: "vatra-cloud", status, message }).catch(() => undefined);

type ErrCode = "forbidden" | "demo_readonly" | "issue_failed" | "invalid" | "failed";
async function fail(code: ErrCode): Promise<ActionResult<never>> {
  const t = await getTranslations("vatraCloud.errors");
  return err(t(code), code);
}
const failure = (e: unknown) => fail(e instanceof HomeAccessError ? "forbidden" : "failed");

export async function getVatraCloudAction(): Promise<ActionResult<VatraCloudView>> {
  try {
    await requireOwner();
    return ok(await view());
  } catch (e) {
    return await failure(e);
  }
}

const toggle = z.object({ enabled: z.boolean() });

/** Remote access through the SNI relay: starts/stops the tunnel (issues the certificate first). */
export async function setVatraRemoteAction(input: { enabled: boolean }): Promise<ActionResult<VatraCloudView>> {
  const p = toggle.safeParse(input);
  if (!p.success) return fail("invalid");
  try {
    await requireOwner();
    if (isDemo()) return await fail("demo_readonly");
    writeIntegrations({ VATRA_CLOUD_REMOTE: p.data.enabled ? "1" : "" });
    await audit(p.data.enabled ? "cloud.remote.enable" : "cloud.remote.disable", "ok", "");
    const { reconcileVatraCloud } = await import("@/lib/cloud");
    void reconcileVatraCloud().catch(() => undefined);
    revalidatePath("/home");
    return ok(await view());
  } catch (e) {
    await audit("cloud.remote.toggle", "error", e instanceof Error ? e.message : String(e));
    return await failure(e);
  }
}

/** Notifications through the Vatra push relay (read by lib/notify). */
export async function setVatraPushAction(input: { enabled: boolean }): Promise<ActionResult<VatraCloudView>> {
  const p = toggle.safeParse(input);
  if (!p.success) return fail("invalid");
  try {
    await requireOwner();
    if (isDemo()) return await fail("demo_readonly");
    writeIntegrations({ VATRA_CLOUD_PUSH: p.data.enabled ? "1" : "" });
    await audit(p.data.enabled ? "cloud.push.enable" : "cloud.push.disable", "ok", "");
    revalidatePath("/home");
    return ok(await view());
  } catch (e) {
    await audit("cloud.push.toggle", "error", e instanceof Error ? e.message : String(e));
    return await failure(e);
  }
}

/** Order a certificate now (first issue or a manual renewal). */
export async function issueVatraCertificateAction(): Promise<ActionResult<VatraCloudView>> {
  try {
    await requireOwner();
    if (isDemo()) return await fail("demo_readonly");
    const { renewCertificateNow } = await import("@/lib/cloud");
    await renewCertificateNow();
    await audit("cloud.cert.issue", "ok", "");
    return ok(await view());
  } catch (e) {
    await audit("cloud.cert.issue", "error", e instanceof Error ? e.message : String(e));
    return await fail(e instanceof HomeAccessError ? "forbidden" : "issue_failed");
  }
}
