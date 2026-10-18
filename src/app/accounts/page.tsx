import { AccountsView, type AccountCardData } from "@/components/accounts/accounts-view";
import { Badge, Button, PageHeader, PageShell } from "@/components/ui";
import { listAccounts } from "@/server/queries";
import { summarizeAccountHealth } from "@/server/queries/account-health";
import { listAccountHistory } from "@/server/queries/history";
import { KeyRound, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const t = await getTranslations("cloud.accounts");
  const accounts = await listAccounts();
  const healthMap = await summarizeAccountHealth();
  const histories = await Promise.all(
    accounts.map(async (a) => {
      const rows = await listAccountHistory(a.id);
      // listAccountHistory returns desc; reverse to oldest-first for the sparkline.
      const ordered = rows.slice().reverse();
      return {
        accountId: a.id,
        runningSeries: ordered.map((r) => r.runningInstances),
        hourlySeries: ordered.map((r) => r.hourlyUsd),
      };
    }),
  );
  const histMap = new Map(histories.map((h) => [h.accountId, h]));

  const cards: AccountCardData[] = accounts.map((a) => {
    const h = healthMap.get(a.id);
    const hist = histMap.get(a.id);
    return {
      id: a.id,
      name: a.name,
      provider: a.provider,
      meta: a.meta?.label ?? a.meta?.accountId ?? null,
      regions: a.regions ?? (a.defaultRegion ? [a.defaultRegion] : []),
      health: h?.health ?? null,
      healthReasons: h?.reasons ?? [],
      lastSyncAt: h?.lastSyncAt ? h.lastSyncAt.toISOString() : null,
      hourlyUsd: hist?.hourlySeries.at(-1) ?? null,
      runningSeries: hist?.runningSeries ?? [],
    };
  });

  return (
    <PageShell>
      <PageHeader
        icon={<KeyRound />}
        title={t("title")}
        description={t("description")}
        badge={<Badge variant="muted">{t("count", { count: accounts.length })}</Badge>}
        actions={
          accounts.length > 0 ? (
            <Button asChild>
              <Link href="/accounts/new">
                <Plus className="size-4" aria-hidden /> {t("add")}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <AccountsView accounts={cards} />
    </PageShell>
  );
}
