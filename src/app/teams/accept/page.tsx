import { Alert, Button, PageHeader, PageShell } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { acceptInvitationAction } from "@/server/actions/teams";
import { MailCheck } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("govern.accept");
  return { title: t("title") };
}

type ErrorKey = "missing" | "notFound" | "accepted" | "expired" | "generic";

function errorKey(error: string): ErrorKey {
  if (error.includes("not found")) return "notFound";
  if (error.includes("already accepted")) return "accepted";
  if (error.includes("expired")) return "expired";
  return "generic";
}

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const t = await getTranslations("govern.accept");

  if (!token) return <AcceptResult title={t("title")} failure={t("errors.missing")} />;

  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/teams/accept?token=${token}`)}`);

  const r = await acceptInvitationAction({ token });
  if (!r.ok) return <AcceptResult title={t("title")} failure={t(`errors.${errorKey(r.error)}`)} />;
  return <AcceptResult title={t("title")} />;
}

async function AcceptResult({ title, failure }: { title: string; failure?: string }) {
  const t = await getTranslations("govern.accept");
  return (
    <PageShell width="narrow">
      <PageHeader title={title} icon={<MailCheck />} />
      <div className="surface space-y-4 p-6">
        {failure ? (
          <Alert tone="danger" title={t("failure.title")}>
            {failure}
          </Alert>
        ) : (
          <Alert tone="success" title={t("success.title")}>
            {t("success.description")}
          </Alert>
        )}
        <Button asChild variant={failure ? "secondary" : "primary"}>
          <Link href="/teams">{failure ? t("failure.cta") : t("success.cta")}</Link>
        </Button>
      </div>
    </PageShell>
  );
}
