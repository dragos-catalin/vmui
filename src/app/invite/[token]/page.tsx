import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { AuthCard } from "@/components/auth/auth-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { inviteByToken } from "@/lib/home/family";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("invite") };
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("auth.invite");
  const inv = await inviteByToken(token);
  const inviter = inv
    ? ((await db.select({ displayName: users.displayName }).from(users).where(eq(users.email, inv.createdBy.toLowerCase())).get())?.displayName ?? inv.createdBy)
    : null;

  return (
    <AuthCard title={inv ? t("title") : t("invalidTitle")} description={inv ? t("description") : undefined}>
      {inv ? (
        <AcceptInviteForm
          token={token}
          name={inv.name}
          role={inv.role}
          rooms={inv.rooms}
          inviter={inviter}
          accessExpiresAt={inv.accessExpiresAt?.toISOString() ?? null}
        />
      ) : (
        <div className="space-y-4">
          <Alert tone="danger">{t("invalidBody")}</Alert>
          <Button asChild variant="outline" className="w-full">
            <Link href="/sign-in">{t("invalidCta")}</Link>
          </Button>
        </div>
      )}
    </AuthCard>
  );
}
