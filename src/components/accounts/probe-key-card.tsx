"use client";

import { toResult } from "@/components/settings/adapt";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { clearProbeKeyAction, uploadProbeKeyAction } from "@/server/actions/probe";
import { Key, ShieldCheck, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  accountId: string;
  hasKey: boolean;
}

export function ProbeKeyCard({ accountId, hasKey }: Props) {
  const t = useTranslations("cloud.accountDetail");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [defaultUser, setDefaultUser] = useState("");

  const upload = useAction(
    async () =>
      toResult(
        await uploadProbeKeyAction({
          accountId,
          privateKey,
          passphrase: passphrase || undefined,
          defaultUser: defaultUser || undefined,
        }),
      ),
    {
      success: t("probe.uploaded"),
      onSuccess: () => {
        setPrivateKey("");
        setPassphrase("");
        setOpen(false);
      },
    },
  );

  const clear = useAction(async () => toResult(await clearProbeKeyAction({ accountId })), { success: t("probe.removed") });

  const onClear = async () => {
    const yes = await confirm({
      title: t("probe.removeTitle"),
      description: t("probe.removeDescription"),
      tone: "danger",
      confirmText: tc("remove"),
    });
    if (yes) await clear.run();
  };

  if (hasKey && !open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-[color-mix(in_oklch,var(--color-primary)_6%,transparent)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="font-medium">{t("probe.configured")}</span>
          <span className="truncate text-muted">{t("probe.configuredHint")}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)} disabled={clear.pending}>
            {t("probe.replace")}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => void onClear()} loading={clear.pending} aria-label={t("probe.removeTitle")}>
            <X className="size-4 text-danger" aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm">
        <Key className="size-3.5" aria-hidden /> {t("probe.upload")}
      </Button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void upload.run();
      }}
      className="space-y-3"
    >
      <Field label={t("probe.privateKey")}>
        <Textarea
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          required
          rows={6}
          spellCheck={false}
          placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("probe.passphrase")}>
          <Input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        <Field label={t("probe.defaultUser")}>
          <Input type="text" value={defaultUser} onChange={(e) => setDefaultUser(e.target.value)} placeholder={t("probe.defaultUserPlaceholder")} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={upload.pending}>
          {t("probe.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {tc("cancel")}
        </Button>
      </div>
    </form>
  );
}
