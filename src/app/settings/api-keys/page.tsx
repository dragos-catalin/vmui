import { ApiKeysManager, type ScopeCatalog } from "@/components/settings/api-keys-manager";
import { PageHeader, PageShell } from "@/components/ui";
import { parseApiKeyScopes } from "@/lib/api-key-scopes";
import { authEnabled, getCurrentUser, ROLE_RANK } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys, instances } from "@/lib/db/schema";
import { DEVICES } from "@/lib/home/catalog";
import { PC_ACTIONS, TOOLS } from "@/lib/mcp/tools";
import { desc } from "drizzle-orm";
import { Key } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import "server-only";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.access.apiKeys");
  return { title: t("title") };
}

export default async function ApiKeysPage() {
  if (await authEnabled()) {
    const me = await getCurrentUser();
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.admin) {
      redirect("/");
    }
  }
  const [rows, vms, t] = await Promise.all([
    db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)),
    db.select({ id: instances.id, name: instances.name, providerInstanceId: instances.providerInstanceId, provider: instances.provider }).from(instances),
    getTranslations("settings.access.apiKeys"),
  ]);

  const entities = new Map<string, string>();
  for (const d of DEVICES) {
    for (const e of [d.entity, ...(d.entities ?? [])]) {
      if (e && !entities.has(e)) entities.set(e, d.name);
    }
  }
  entities.set("light.hyperhdr", "Ambilight (HyperHDR)");

  const catalog: ScopeCatalog = {
    tools: TOOLS.map((tool) => ({ name: tool.name, destructive: !!tool.destructive, readOnly: !!tool.readOnly })),
    vms: vms.map((v) => ({ id: v.id, label: v.name ?? v.providerInstanceId, provider: v.provider })),
    entities: [...entities.entries()].map(([id, label]) => ({ id, label })),
    pcActions: [...PC_ACTIONS],
  };

  return (
    <PageShell width="narrow">
      <PageHeader title={t("title")} description={t("description")} icon={<Key />} />
      <ApiKeysManager
        catalog={catalog}
        keys={rows.map((k) => ({
          id: k.id,
          name: k.name,
          role: k.role,
          rateLimitPerMinute: k.rateLimitPerMinute,
          createdAt: k.createdAt,
          revokedAt: k.revokedAt,
          lastUsedAt: k.lastUsedAt,
          scopes: parseApiKeyScopes(k.scopes),
        }))}
      />
      <p className="text-xs text-fg-muted">
        {t.rich("usage", { code: (chunks) => <code className="rounded bg-surface-2 px-1 font-mono">{chunks}</code> })}
      </p>
    </PageShell>
  );
}
