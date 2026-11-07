"use client";

import { AuthField, PasswordInput } from "@/components/auth/auth-field";
import { Alert, Button } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { deleteMyAccountAction, myDeletionStatusAction } from "@/server/actions/account";
import { UserX } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { toResult } from "./adapt";

type Status = Awaited<ReturnType<typeof myDeletionStatusAction>>;

export function DeleteAccountCard() {
  const t = useTranslations("legal.accountCard");
  const id = useId();
  const confirm = useConfirm();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void myDeletionStatusAction().then(setStatus);
  }, []);

  const del = useAction(async (pw: string) => toResult(await deleteMyAccountAction({ password: pw })), {
    success: t("deleted"),
    refresh: false,
    onSuccess: () => window.location.assign("/sign-in"),
  });

  const learnMore = (
    <Link href="/account/delete" className="text-xs underline underline-offset-4">
      {t("learnMore")}
    </Link>
  );

  if (status && !status.canDelete && status.reason) {
    const owner = status.reason === "owner";
    return (
      <Alert tone="info" title={owner ? t("ownerTitle") : t("lastAdminTitle")} action={learnMore}>
        {owner ? t("ownerBody") : t("lastAdminBody")}
      </Alert>
    );
  }

  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!password) return;
        if (!(await confirm({ title: t("confirmTitle"), description: t("confirmBody"), tone: "danger", confirmText: t("confirm") }))) return;
        void del.run(password);
      }}
    >
      <p className="text-sm text-fg-muted sm:col-span-2">{t("body")}</p>
      <AuthField id={`${id}-pw`} label={t("password")}>
        {(a11y) => <PasswordInput {...a11y} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
      </AuthField>
      <Button type="submit" variant="danger" loading={del.pending} disabled={!password || !status}>
        <UserX className="size-4" aria-hidden /> {t("submit")}
      </Button>
      <div className="sm:col-span-2">{learnMore}</div>
    </form>
  );
}
