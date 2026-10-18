import { SshConfigExport } from "@/components/settings/ssh-config-export";
import { SshKeyComposer } from "@/components/settings/ssh-key-composer";
import { SshKeyList } from "@/components/settings/ssh-key-list";
import { PageHeader, PageShell } from "@/components/ui";
import { listInstances } from "@/server/queries";
import { listSshKeys } from "@/server/queries/ssh-keys";
import { KeyRound } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.access.sshKeys");
  return { title: t("title") };
}

export default async function SshKeysPage() {
  const [keys, vms, t] = await Promise.all([listSshKeys(), listInstances(), getTranslations("settings.access.sshKeys")]);
  const reachable = vms.filter((v) => v.publicIp || v.publicDns);
  return (
    <PageShell width="narrow">
      <PageHeader title={t("title")} description={t("description")} icon={<KeyRound />} />
      <SshKeyComposer />
      <SshKeyList keys={keys} />
      <SshConfigExport
        instances={reachable.map((v) => ({
          id: v.id,
          host: v.displayName ?? v.name ?? v.providerInstanceId,
          provider: v.provider,
          ip: v.publicIp ?? v.publicDns ?? "",
          keyName: v.keyName,
          platform: v.platform,
        }))}
      />
    </PageShell>
  );
}
