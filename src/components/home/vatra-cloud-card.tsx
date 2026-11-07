"use client";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Panel, Subsection } from "@/components/ui/settings-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useInterval } from "@/hooks/use-poll";
import { getVatraCloudAction, issueVatraCertificateAction, setVatraPushAction, setVatraRemoteAction, type VatraCloudView } from "@/server/actions/vatra-cloud";
import { Copy, ShieldCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";

const STATE_VARIANT = { off: "muted", connecting: "info", online: "success", error: "danger" } as const;

/** Settings → Extensions → Vatra Cloud: remote access through the SNI relay and the push relay
 *  (docs/product/cloud/CONTRACT.md). Owner-only, like the settings tab itself. */
export function VatraCloudCard() {
  const t = useTranslations("vatraCloud");
  const fmt = useFormatter();
  const [view, setView] = React.useState<VatraCloudView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await getVatraCloudAction();
    if (r.ok) {
      setView(r.data);
      setLoadError(null);
    } else setLoadError(r.error);
  }, []);
  React.useEffect(() => void load(), [load]);
  useInterval(() => void load(), view?.remote ? 5000 : 30_000, { pauseHidden: true });

  const remote = useAction(setVatraRemoteAction, { refresh: false, onSuccess: setView, success: (v) => (v.remote ? t("remote.on") : t("remote.off")) });
  const push = useAction(setVatraPushAction, { refresh: false, onSuccess: setView, success: (v) => (v.push ? t("push.on") : t("push.off")) });
  const issue = useAction(issueVatraCertificateAction, { refresh: false, onSuccess: setView, success: t("cert.issued") });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("copied"));
    } catch {
      // clipboard blocked (insecure context): the value stays selectable
    }
  };

  const date = (ms: number) => fmt.dateTime(new Date(ms), { dateStyle: "medium", timeStyle: "short" });

  return (
    <Panel id="vatra-cloud" title={t("title")} description={t("intro")}>
      {!view ? (
        loadError ? (
          <Alert tone="danger">{loadError}</Alert>
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )
      ) : (
        <div className="space-y-5">
          <Alert tone="info">{t("beta")}</Alert>

          <dl className="grid gap-3 sm:grid-cols-2">
            {([
              ["hubId", view.hubId],
              ["publicUrl", view.publicUrl],
            ] as const).map(([key, value]) => (
              <div key={key} className="min-w-0 rounded-lg border border-[var(--color-border)] px-3 py-2">
                <dt className="text-xs text-muted">{t(key)}</dt>
                <dd className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 select-all truncate font-mono text-sm">{value}</span>
                  <Button type="button" variant="ghost" size="icon" aria-label={`${t("copy")} ${t(key)}`} onClick={() => void copy(value)}>
                    <Copy className="size-4" aria-hidden />
                  </Button>
                </dd>
              </div>
            ))}
          </dl>

          <div className="space-y-2">
            <Field inline label={t("remote.label")} hint={t("remote.hint")}>
              <Switch checked={view.remote} disabled={remote.pending} onCheckedChange={(enabled) => void remote.run({ enabled })} aria-label={t("remote.label")} />
            </Field>
            <Field inline label={t("push.label")} hint={t("push.hint")}>
              <Switch checked={view.push} disabled={push.pending} onCheckedChange={(enabled) => void push.run({ enabled })} aria-label={t("push.label")} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
            <span className="text-muted">{t("state.label")}</span>
            <Badge variant={STATE_VARIANT[view.state]} dot>
              {t(`state.${view.state}`)}
            </Badge>
            {view.state === "online" && <span className="text-xs text-muted">{t("state.clients", { count: view.clients })}</span>}
          </div>
          {view.lastError && view.state !== "online" && <Alert tone="warning">{t("lastError", { error: view.lastError })}</Alert>}

          <Subsection
            title={t("cert.title")}
            action={
              <Button type="button" size="sm" variant="outline" disabled={issue.pending} onClick={() => void issue.run()}>
                {t("cert.issue")}
              </Button>
            }
          >
            {view.certNotAfter ? (
              <ul className="space-y-1 text-sm">
                <li>{t("cert.expires", { date: date(view.certNotAfter) })}</li>
                {view.certRenewAt ? <li className="text-muted">{t("cert.renews", { date: date(view.certRenewAt) })}</li> : null}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t("cert.none")}</p>
            )}
            {view.certError && <p className="text-xs text-danger">{t("cert.error", { error: view.certError })}</p>}
          </Subsection>

          <Subsection title={t("privacy.title")}>
            <div className="flex gap-3 text-sm">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary-text" aria-hidden />
              <p className="leading-relaxed text-muted">
                {t("privacy.body")}{" "}
                <Link href="/privacy" className="font-medium text-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {t("privacy.link")}
                </Link>
              </p>
            </div>
          </Subsection>
        </div>
      )}
    </Panel>
  );
}
