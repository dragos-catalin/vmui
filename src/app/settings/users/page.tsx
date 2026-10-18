import { CreateUserDialog } from "@/components/settings/create-user-dialog";
import { UsersTable } from "@/components/settings/users-table";
import { Alert, Badge, Button, PageHeader, PageSection, PageShell } from "@/components/ui";
import { authEnabled, getCurrentUser, ROLE_RANK } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { House, Users as UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import "server-only";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.users");
  return { title: t("title") };
}

export default async function UsersPage() {
  const t = await getTranslations("settings.users");
  if (!(await authEnabled())) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t("title")} description={t("description")} icon={<UsersIcon />} />
        <Alert
          tone="info"
          title={t("disabledTitle")}
          action={
            <Button asChild size="sm">
              <Link href="/sign-up">{t("createFirst")}</Link>
            </Button>
          }
        >
          {t("disabledHint")}
        </Alert>
      </PageShell>
    );
  }
  const me = await getCurrentUser();
  if (!me || ROLE_RANK[me.role] < ROLE_RANK.admin) {
    redirect("/");
  }
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  const tr = await getTranslations("auth.roles");

  return (
    <PageShell>
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<UsersIcon />}
        badge={<Badge variant="muted">{t("count", { count: rows.length })}</Badge>}
        actions={<CreateUserDialog />}
      />
      <PageSection title={t("title")} description={t("count", { count: rows.length })}>
        <UsersTable
          meId={me.id}
          users={rows.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            createdAt: u.createdAt,
            lastLoginAt: u.lastLoginAt,
          }))}
        />
      </PageSection>
      <PageSection
        title={t("legend.title")}
        description={t("hubHint")}
        action={
          <Button asChild size="sm" variant="secondary">
            <Link href="/home?tab=settings&section=family">
              <House className="size-4" aria-hidden /> {t("familyLink")}
            </Link>
          </Button>
        }
      >
        <ul className="space-y-2 text-sm">
          <li className="flex flex-wrap items-baseline gap-2">
            <Badge variant="info">{tr("admin")}</Badge>
            <span className="text-fg-muted">{t("legend.admin")}</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <Badge>{tr("operator")}</Badge>
            <span className="text-fg-muted">{t("legend.operator")}</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <Badge variant="muted">{tr("viewer")}</Badge>
            <span className="text-fg-muted">{t("legend.viewer")}</span>
          </li>
          <li className="pt-1 text-fg-muted">{t("familyHint")}</li>
        </ul>
      </PageSection>
    </PageShell>
  );
}
