import type { FamilyCandidate, FamilyInviteView, FamilyMemberView } from "@/components/home/family-card";
import { HomeDashboard } from "@/components/home/home-dashboard";
import { normalizeHomeTab, normalizeSettingsSection } from "@/components/home/tabs";
import { Alert, Button, EmptyState, PageHeader, PageShell } from "@/components/ui";
import { loadCopilotSignals } from "@/lib/copilot/signals";
import { loadDisplaySettings } from "@/lib/display/settings";
import { accessView, currentHomeActor, journalUserId } from "@/lib/home/access";
import { loadButtonBindings } from "@/lib/home/button-bindings";
import { credential } from "@/lib/home/credentials";
import { listInvites, listMembers, nonMembers } from "@/lib/home/family";
import { ha } from "@/lib/home/ha-client";
import { intercomState } from "@/lib/home/intercom";
import { loadProfile } from "@/lib/nutrition/store";
import { nutritionSummary } from "@/lib/nutrition/summary";
import { loadPomodoro, loadTurzxSettings } from "@/lib/turzx/settings";
import { homeAvailability, listPlacedDevices, loadHomeStates, wallSetting } from "@/server/queries/home";
import { ExternalLink, House, UserX } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("home");
  return { title: `${t("title")} — vmui` };
}

function intercomProps() {
  const s = intercomState();
  return { ringing: s.ringingSince !== null, ringingSince: s.ringingSince, lastRingAt: s.lastRingAt, lastOpenAt: s.lastOpenAt, autoOpenUntil: s.autoOpenUntil, log: s.log };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function familyProps(): Promise<{ members: FamilyMemberView[]; invites: FamilyInviteView[]; candidates: FamilyCandidate[]; origin: string }> {
  const [members, invites, candidates, h] = await Promise.all([listMembers(), listInvites(), nonMembers(), headers()]);
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3737";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return {
    members: members.map((m) => ({ ...m, expiresAt: iso(m.expiresAt), lastLoginAt: iso(m.lastLoginAt), devices: m.devices.map((d) => ({ ...d, lastSeenAt: iso(d.lastSeenAt) })) })),
    invites: invites.map((i) => ({ id: i.id, name: i.name, role: i.role, rooms: i.rooms, accessExpiresAt: iso(i.accessExpiresAt), expiresAt: i.expiresAt.toISOString() })),
    candidates,
    origin: `${proto}://${host}`,
  };
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ tab?: string; section?: string }> }) {
  const [actor, t] = await Promise.all([currentHomeActor(), getTranslations("home")]);
  if (!actor) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t("title")} icon={<House />} />
        <EmptyState icon={<UserX />} title={t("noAccess.title")} description={t("noAccess.hint")} />
      </PageShell>
    );
  }
  const access = accessView(actor);
  const uid = journalUserId(actor);
  const scope = uid ? { userId: uid, isOwner: access.canManage } : null;
  const [{ tab, section }, devices, states, avail, wall, turzx, display, pomodoro, copilot, nutrition, nutritionProfile, buttons, family] = await Promise.all([
    searchParams,
    listPlacedDevices(actor),
    loadHomeStates(actor),
    homeAvailability(),
    wallSetting(),
    loadTurzxSettings(),
    loadDisplaySettings(),
    loadPomodoro(),
    loadCopilotSignals(),
    nutritionSummary(scope),
    loadProfile(uid, access.canManage),
    loadButtonBindings(),
    access.canManage ? familyProps() : Promise.resolve(null),
  ]);
  const haScripts = Object.keys(states).filter((id) => id.startsWith("script.")).map((id) => id.slice("script.".length)).sort();
  // Any HA light that can show a colour may carry a Copilot signal.
  const rgbLights = Object.values(states)
    .filter((s) => s.entity_id.startsWith("light.") && s.entity_id !== "light.hyperhdr" && ((s.attributes.supported_color_modes as string[] | undefined) ?? []).some((m) => m === "rgb" || m === "hs" || m === "rgbw" || m === "rgbww" || m === "xy"))
    .map((s) => ({ id: s.entity_id, name: String(s.attributes.friendly_name ?? s.entity_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const haConfigured = ha.configured();
  const initialTab = normalizeHomeTab(tab, access.canManage);
  const initialSection = normalizeSettingsSection(tab, section);
  return (
    <PageShell>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        icon={<House />}
        actions={
          avail.url ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={avail.url} target="_blank" rel="noreferrer">
                {t("openHa")} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </Button>
          ) : undefined
        }
      />

      {!avail.ok && (
        <Alert tone="warning" title={t("haDown")}>
          {haConfigured
            ? t("haDownHint", { error: avail.error ?? "" })
            : t.rich("haNotConfigured", { code: (chunks) => <code className="rounded-sm bg-bg-muted px-1 font-mono text-xs">{chunks}</code> })}
        </Alert>
      )}

      <HomeDashboard access={access} family={family} devices={devices} initialStates={states} haUrl={avail.url} initialTab={initialTab} initialSection={initialSection} wall={wall} turzx={turzx} display={display} pomodoro={pomodoro} copilot={copilot} rgbLights={rgbLights} nutrition={nutrition} nutritionProfile={nutritionProfile} intercom={intercomProps()} espToken={access.canManage ? credential("ESP_DISPLAY_TOKEN") ?? "" : ""} buttons={buttons} haScripts={haScripts} />
    </PageShell>
  );
}
