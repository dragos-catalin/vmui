"use client";

import { PasswordInput } from "@/components/auth/auth-field";
import { Alert, Button, Field, PageSection } from "@/components/ui";
import { DatabaseBackup, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

const MIN = 12;

export async function errorText(r: Response, fallback: string): Promise<string> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  return j?.error ?? fallback;
}

/** After a restore the hub restarts; wait until it answers, then go to sign-in. */
export async function waitForHub(): Promise<void> {
  await new Promise((res) => setTimeout(res, 3000));
  for (let i = 0; i < 60; i++) {
    if ((await fetch("/api/discover", { cache: "no-store" }).catch(() => null))?.ok) {
      window.location.assign("/sign-in");
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** Whole-hub encrypted backup + restore (P5-06). Owner only; the API enforces it too. */
export function HubBackupCard() {
  const t = useTranslations("settings.data.hubBackup");
  const [pending, start] = useTransition();
  const [pass, setPass] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [restarting, setRestarting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const download = () =>
    start(async () => {
      const r = await fetch("/api/backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
      if (!r.ok) {
        toast.error(await errorText(r, t("failed")));
        return;
      }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "vatra.vatrabk";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setPass("");
      toast.success(t("created"));
    });

  const restore = () =>
    start(async () => {
      if (!file || !window.confirm(t("confirm"))) return;
      const fd = new FormData();
      fd.set("file", file);
      fd.set("passphrase", restorePass);
      const r = await fetch("/api/backup/restore", { method: "POST", body: fd });
      if (!r.ok) {
        toast.error(await errorText(r, t("failed")));
        return;
      }
      setRestarting(true);
      setRestorePass("");
      await waitForHub();
    });

  return (
    <PageSection title={t("title")} description={t("description")}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t("createTitle")}</h3>
          <Field label={t("passphrase")} hint={t("passphraseHint")}>
            <PasswordInput value={pass} onChange={(e) => setPass(e.currentTarget.value)} autoComplete="new-password" minLength={MIN} maxLength={512} disabled={pending} />
          </Field>
          <Button onClick={download} loading={pending} disabled={pass.length < MIN}>
            <DatabaseBackup className="size-4" aria-hidden /> {t("create")}
          </Button>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t("restoreTitle")}</h3>
          <input
            ref={fileRef}
            type="file"
            accept=".vatrabk,application/octet-stream"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            disabled={pending}
            onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()} disabled={pending}>
              <Upload className="size-4" aria-hidden /> {t("pick")}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted" aria-live="polite">
              {file ? file.name : t("fileHint")}
            </span>
          </div>
          <Field label={t("passphrase")}>
            <PasswordInput value={restorePass} onChange={(e) => setRestorePass(e.currentTarget.value)} autoComplete="off" maxLength={512} disabled={pending} />
          </Field>
          <Button variant="danger" onClick={restore} loading={pending} disabled={!file || !restorePass}>
            {t("restore")}
          </Button>
          {restarting && <Alert tone="info">{t("restarting")}</Alert>}
        </div>
      </div>
    </PageSection>
  );
}
