import { SettingsHub } from "@/components/settings/settings-hub";
import { authEnabled } from "@/lib/auth";
import { getCodaiSettingsPublic } from "@/lib/codai/settings";
import { getQuietHours } from "@/lib/quiet-hours";
import { listBootScriptsAction } from "@/server/actions/boot-scripts";
import { listKnownHostsAction } from "@/server/actions/known-hosts";
import { listWebhooksAction } from "@/server/actions/webhooks";
import { getSettings } from "@/server/queries/settings";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("title") };
}

export default async function SettingsPage() {
  const [snapshot, knownHosts, webhooks, bootScripts, quietHours, auth, codai] = await Promise.all([
    getSettings(),
    listKnownHostsAction(),
    listWebhooksAction(),
    listBootScriptsAction(),
    getQuietHours(),
    authEnabled(),
    getCodaiSettingsPublic(),
  ]);
  return (
    <SettingsHub
      snapshot={snapshot}
      knownHosts={knownHosts}
      webhooks={webhooks}
      bootScripts={bootScripts}
      quietHours={quietHours}
      authEnabled={auth}
      codai={codai}
    />
  );
}
