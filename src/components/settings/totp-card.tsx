"use client";

import { Alert, Badge, Button, Field, Input, SkeletonText } from "@/components/ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    confirmTotpEnrollmentAction,
    disableTotpAction,
    getTotpStatusAction,
    pingTotpAction,
    regenerateBackupCodesAction,
    startTotpEnrollmentAction,
    type TotpStatus,
} from "@/server/actions/totp";
import { Check, Copy, KeyRound, RefreshCcw, ShieldCheck, ShieldOff } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

type Stage =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "enrolling"; qr: string; secret: string; enrollmentId: string; code: string }
  | { kind: "on"; status: TotpStatus };

type Prompt = { kind: "disable" | "regenerate" | "test"; value: string };

export function TotpCard() {
  const t = useTranslations("settings.security.totp");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [pending, start] = useTransition();
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const refresh = useCallback(async () => {
    const status = await getTotpStatusAction();
    setStage(status.enrolled ? { kind: "on", status } : { kind: "off" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function enroll() {
    start(async () => {
      const r = await startTotpEnrollmentAction();
      if (r.ok) {
        setStage({ kind: "enrolling", qr: r.qrDataUrl, secret: r.secret, enrollmentId: r.enrollmentId, code: "" });
      } else {
        toast.error(r.error);
      }
    });
  }

  function confirm() {
    if (stage.kind !== "enrolling") return;
    const enrollmentId = stage.enrollmentId;
    const code = stage.code;
    start(async () => {
      const r = await confirmTotpEnrollmentAction({ enrollmentId, code });
      if (r.ok) {
        setNewCodes(r.backupCodes);
        toast.success(t("enabledToast"));
        await refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  function submitPrompt() {
    if (!prompt || !prompt.value.trim()) return;
    const { kind, value } = prompt;
    start(async () => {
      if (kind === "disable") {
        const r = await disableTotpAction({ password: value });
        if (r.ok) {
          toast.success(t("disabled"));
          setNewCodes(null);
          await refresh();
        } else {
          toast.error(r.error ?? tc("failed"));
          return;
        }
      } else if (kind === "regenerate") {
        const r = await regenerateBackupCodesAction({ password: value });
        if (r.ok) {
          setNewCodes(r.codes);
          toast.success(t("regenerated"));
          await refresh();
        } else {
          toast.error(r.error);
          return;
        }
      } else {
        const r = await pingTotpAction({ code: value.trim() });
        if (r.ok) toast.success(t("testOk"));
        else {
          toast.error(t("testFail"));
          return;
        }
      }
      setPrompt(null);
    });
  }

  async function copyCodes() {
    if (!newCodes) return;
    await navigator.clipboard.writeText(newCodes.join("\n"));
    toast.success(t("codesCopied"));
  }

  if (stage.kind === "loading") {
    return <SkeletonText lines={2} />;
  }

  if (stage.kind === "off") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">{t("offHint")}</p>
        <Button onClick={enroll} loading={pending}>
          <ShieldCheck className="size-4" aria-hidden /> {t("enable")}
        </Button>
      </div>
    );
  }

  if (stage.kind === "enrolling") {
    return (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from the server, next/image cannot optimise it */}
        <img src={stage.qr} alt={t("qrAlt")} width={180} height={180} className="size-[180px] shrink-0 self-center rounded-[var(--radius-md)] border border-border bg-[oklch(1_0_0)] p-1 sm:self-start" />
        <div className="min-w-0 flex-1 space-y-3 text-sm">
          <p className="text-fg-muted">{t("step1")}</p>
          <p className="text-fg-muted">
            {t("manual")} <code className="break-all rounded bg-bg-muted px-1 py-0.5 font-mono text-xs">{stage.secret}</code>
          </p>
          <p className="text-fg-muted">{t("step2")}</p>
          <div className="flex flex-wrap items-center gap-2">
              <Input
                value={stage.code}
                onChange={(e) => setStage({ ...stage, code: e.target.value })}
              placeholder={t("codePlaceholder")}
                inputMode="numeric"
              autoComplete="one-time-code"
                maxLength={10}
              aria-label={t("step2")}
              className="w-32 font-mono tabular-nums"
              />
            <Button onClick={confirm} disabled={stage.code.length < 6} loading={pending}>
              <Check className="size-4" aria-hidden /> {t("verify")}
              </Button>
            <Button onClick={() => setStage({ kind: "off" })} variant="ghost">
              {tc("cancel")}
              </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="success">{t("enabled")}</Badge>
        <span className="text-fg-muted">
          {stage.status.verifiedAt ? t("enrolledAt", { date: format.dateTime(new Date(stage.status.verifiedAt), { dateStyle: "medium" }) }) : null}
          {stage.status.verifiedAt ? " · " : null}
          {t("backupRemaining", { count: stage.status.backupCodesRemaining })}
        </span>
      </div>
      {newCodes && (
        <Alert
          tone="warning"
          title={t("saveCodes")}
          action={
            <Button onClick={() => void copyCodes()} size="sm" variant="outline">
              <Copy className="size-4" aria-hidden /> {t("copyAll")}
            </Button>
          }
        >
          <p>{t("saveCodesHint")}</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-fg sm:grid-cols-3">
            {newCodes.map((c) => (
              <li key={c} className="rounded-[var(--radius-sm)] bg-surface px-2 py-1 tabular-nums">
                {c}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setPrompt({ kind: "test", value: "" })} variant="outline" size="sm">
          <KeyRound className="size-4" aria-hidden /> {t("testCode")}
        </Button>
        <Button onClick={() => setPrompt({ kind: "regenerate", value: "" })} variant="outline" size="sm" disabled={pending}>
          <RefreshCcw className="size-4" aria-hidden /> {t("regenerate")}
        </Button>
        <Button onClick={() => setPrompt({ kind: "disable", value: "" })} variant="ghost" size="sm" disabled={pending} className="text-danger">
          <ShieldOff className="size-4" aria-hidden /> {t("disable")}
        </Button>
      </div>

      <Dialog open={prompt !== null} onOpenChange={(o) => !o && setPrompt(null)}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitPrompt();
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>{prompt?.kind === "test" ? t("testCode") : prompt?.kind === "regenerate" ? t("regenerate") : t("disable")}</DialogTitle>
              <DialogDescription>
                {prompt?.kind === "test" ? t("testPrompt") : prompt?.kind === "regenerate" ? t("regeneratePrompt") : t("disablePrompt")}
              </DialogDescription>
            </DialogHeader>
            <Field label={prompt?.kind === "test" ? t("codePlaceholder") : t("password")}>
              <Input
                autoFocus
                type={prompt?.kind === "test" ? "text" : "password"}
                inputMode={prompt?.kind === "test" ? "numeric" : undefined}
                autoComplete={prompt?.kind === "test" ? "one-time-code" : "current-password"}
                value={prompt?.value ?? ""}
                onChange={(e) => prompt && setPrompt({ ...prompt, value: e.target.value })}
                className={prompt?.kind === "test" ? "font-mono tabular-nums" : undefined}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPrompt(null)}>
                {tc("cancel")}
              </Button>
              <Button type="submit" variant={prompt?.kind === "disable" ? "danger" : "primary"} loading={pending} disabled={!prompt?.value.trim()}>
                {t("confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
