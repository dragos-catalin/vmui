"use client";

import { useAuthMark } from "@/components/auth/auth-card";
import { translateAuthError } from "@/components/auth/auth-errors";
import { AuthField, PasswordInput } from "@/components/auth/auth-field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { signUpAction, type SignUpState } from "@/server/actions/auth";
import { useTranslations } from "next-intl";
import { useActionState } from "react";

const initial: SignUpState = undefined;
const ROLES = ["admin", "operator", "viewer"] as const;

export function SignUpForm({ firstUser }: { firstUser: boolean }) {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(signUpAction, initial);
  useAuthMark(pending, pending ? null : (state?.error ?? null));
  const error = translateAuthError(t, state?.error);
  return (
    <form action={action} className="space-y-4">
      <AuthField id="displayName" label={t("fields.displayName")}>
        {(a11y) => <Input {...a11y} name="displayName" autoComplete="name" maxLength={80} required />}
      </AuthField>
      <AuthField id="email" label={t("fields.email")}>
        {(a11y) => <Input {...a11y} name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required />}
      </AuthField>
      <AuthField id="password" label={t("fields.password")} hint={t("fields.passwordHint")}>
        {(a11y) => <PasswordInput {...a11y} name="password" autoComplete="new-password" minLength={8} maxLength={200} required />}
      </AuthField>
      {!firstUser && (
        <div className="space-y-1.5">
          <Label htmlFor="role">{t("fields.role")}</Label>
          <Select name="role" defaultValue="viewer">
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`roles.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" loading={pending} className="w-full">
        {firstUser ? t("signUp.submitFirst") : t("signUp.submitAdd")}
      </Button>
    </form>
  );
}
