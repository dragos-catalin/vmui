"use client";

import { useAuthMark } from "@/components/auth/auth-card";
import { AuthField, PasswordInput } from "@/components/auth/auth-field";
import { errorText, waitForHub } from "@/components/settings/hub-backup-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

/** Fresh hub: restore a whole-hub backup instead of claiming (P5-06). The setup code proves physical access. */
export function RestoreForm() {
  const t = useTranslations("auth.restore");
  const ta = useTranslations("auth");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useAuthMark(pending, pending ? null : error);

  const submit = (fd: FormData) =>
    start(async () => {
      setError(null);
      const r = await fetch("/api/backup/restore", { method: "POST", body: fd });
      if (!r.ok) {
        setError(await errorText(r, t("failed")));
        return;
      }
      setDone(true);
      await waitForHub();
    });

  if (done) return <Alert tone="info">{t("restarting")}</Alert>;
  return (
    <form action={submit} className="space-y-4">
      <AuthField id="setupCode" label={ta("fields.setupCode")} hint={ta("fields.setupCodeHint")}>
        {(a11y) => <Input {...a11y} name="setupCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className="font-mono tracking-[0.3em]" />}
      </AuthField>
      <AuthField id="file" label={t("file")} hint={t("fileHint")}>
        {(a11y) => <Input {...a11y} name="file" type="file" accept=".vatrabk,application/octet-stream" required />}
      </AuthField>
      <AuthField id="passphrase" label={t("passphrase")}>
        {(a11y) => <PasswordInput {...a11y} name="passphrase" autoComplete="off" maxLength={512} required />}
      </AuthField>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" loading={pending} className="w-full">
        {t("submit")}
      </Button>
    </form>
  );
}
