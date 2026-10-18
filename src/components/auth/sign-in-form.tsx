"use client";

import { useAuthMark } from "@/components/auth/auth-card";
import { translateAuthError } from "@/components/auth/auth-errors";
import { AuthField, PasswordInput } from "@/components/auth/auth-field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInAction, verifyTotpAction, type SignInState } from "@/server/actions/auth";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState } from "react";

const initial: SignInState = undefined;

export function SignInForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(signInAction, initial);
  const [totpState, totpFormAction, totpPending] = useActionState(verifyTotpAction, initial);
  useAuthMark(pending || totpPending, totpPending || pending ? null : (totpState?.error ?? state?.error ?? null));

  // Once a sign-in returns pending2FA, switch the form to the code prompt.
  // Failures on verifyTotpAction also carry pending2FA so the user can retry without the password.
  const challenge = totpState?.pending2FA ?? state?.pending2FA ?? null;
  const challengeEmail = totpState?.pendingEmail ?? state?.pendingEmail ?? "";

  if (challenge) {
    const error = translateAuthError(t, totpState?.error);
    return (
      <form action={totpFormAction} className="space-y-4">
        <Alert tone="info" icon={<ShieldCheck />} title={t("signIn.twoFactorTitle")}>
          {t.rich("signIn.twoFactorBody", { email: challengeEmail, b: (chunks) => <strong className="break-all text-fg">{chunks}</strong> })}
        </Alert>
        <input type="hidden" name="token" value={challenge} />
        <AuthField id="code" label={t("fields.code")} error={error}>
          {(a11y) => <Input {...a11y} name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus placeholder={t("fields.codePlaceholder")} />}
        </AuthField>
        <Button type="submit" loading={totpPending} className="w-full">
          {t("signIn.verify")}
        </Button>
      </form>
    );
  }

  const error = translateAuthError(t, state?.error);
  return (
    <form action={action} className="space-y-4">
      <AuthField id="email" label={t("fields.email")}>
        {(a11y) => <Input {...a11y} name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required />}
      </AuthField>
      <AuthField id="password" label={t("fields.password")} error={error}>
        {(a11y) => <PasswordInput {...a11y} name="password" autoComplete="current-password" required />}
      </AuthField>
      <Button type="submit" loading={pending} className="w-full">
        {t("signIn.submit")}
      </Button>
    </form>
  );
}
