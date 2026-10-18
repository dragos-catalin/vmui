"use client";

import { useAuthMark } from "@/components/auth/auth-card";
import { translateAuthError } from "@/components/auth/auth-errors";
import { AuthField, PasswordInput } from "@/components/auth/auth-field";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import type { FamilyRole, RoomGrants } from "@/lib/home/access-model";
import { ROOMS } from "@/lib/home/catalog";
import { acceptInviteAction } from "@/server/actions/family";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";

export function AcceptInviteForm({
  token,
  name,
  role,
  rooms,
  inviter,
  accessExpiresAt,
}: {
  token: string;
  name: string;
  role: Exclude<FamilyRole, "owner">;
  rooms: RoomGrants;
  inviter: string | null;
  accessExpiresAt: string | null;
}) {
  const t = useTranslations("auth");
  const family = useTranslations("family");
  const roomNames = useTranslations("home.rooms");
  const format = useFormatter();
  const router = useRouter();
  const [displayName, setDisplayName] = React.useState(name);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [fieldError, setFieldError] = React.useState<{ password?: string; confirm?: string; email?: string }>({});

  const granted = ROOMS.filter((r) => rooms[r.id]);

  const accept = useAction(
    async (): Promise<ActionResult> => {
      const r = await acceptInviteAction({ token, email, displayName, password });
      if (r.ok) return { ok: true };
      if (r.error === "email_taken") setFieldError({ email: t("errors.emailTaken") });
      return { ok: false, error: translateAuthError(t, r.error) ?? r.error };
    },
    { success: t("invite.joined"), refresh: false, onSuccess: () => router.push("/home") },
  );
  const formError = fieldError.email ? null : accept.lastError;
  useAuthMark(accept.pending, accept.lastError);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError({});
    if (password.length < 8) return void setFieldError({ password: t("validation.passwordShort") });
    if (password !== confirm) return void setFieldError({ confirm: t("validation.passwordMismatch") });
    void accept.run();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2 rounded-[var(--radius-lg)] border border-border bg-[color-mix(in_oklch,var(--color-primary)_8%,transparent)] px-3 py-2.5 text-xs">
        {inviter && (
          <p className="min-w-0 truncate text-fg-muted" title={t("invite.invitedBy", { name: inviter })}>
            {t("invite.invitedBy", { name: inviter })}
          </p>
        )}
        <p className="flex flex-wrap items-center gap-2">
          <span>{t("invite.invitedAs")}</span>
          <Badge variant="info">{family(`roles.${role}`)}</Badge>
        </p>
        {granted.length === 0 ? (
          <p className="text-fg-muted">{t("invite.noRooms")}</p>
        ) : (
          <>
            <p className="text-fg-muted">{t("invite.roomsIntro")}</p>
            <ul className="flex flex-wrap gap-1.5">
              {granted.map((r) => (
                <li key={r.id} className="min-w-0">
                  <Badge variant="muted" className="max-w-full">
                    <span className="truncate" title={roomNames(r.id)}>
                      {roomNames(r.id)}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{family(`level.${rooms[r.id] ?? "view"}`)}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
        {accessExpiresAt && <p className="text-fg-muted">{t("invite.accessUntil", { date: format.dateTime(new Date(accessExpiresAt), { dateStyle: "medium", timeStyle: "short" }) })}</p>}
      </div>
      <AuthField id="displayName" label={t("invite.displayName")}>
        {(a11y) => <Input {...a11y} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={80} required />}
      </AuthField>
      <AuthField id="email" label={t("fields.email")} error={fieldError.email}>
        {(a11y) => <Input {...a11y} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={200} required />}
      </AuthField>
      <AuthField id="password" label={t("fields.password")} hint={t("fields.passwordHint")} error={fieldError.password}>
        {(a11y) => <PasswordInput {...a11y} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} required />}
      </AuthField>
      <AuthField id="confirm" label={t("fields.confirmPassword")} error={fieldError.confirm}>
        {(a11y) => <PasswordInput {...a11y} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} required />}
      </AuthField>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <Button type="submit" loading={accept.pending} className="w-full">
        {t("invite.submit")}
      </Button>
    </form>
  );
}
