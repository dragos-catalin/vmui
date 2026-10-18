import { Alert, Button } from "@/components/ui";
import { env } from "@/lib/env";
import { formatUsd, HOURS_PER_MONTH } from "@/lib/utils";
import { detectCostAnomalies } from "@/server/queries/anomalies";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import "server-only";

const WEBHOOK_MIN_INTERVAL_MS = 60 * 60 * 1000;
let lastWebhookDigest = "";
let lastWebhookAt = 0;

/** Fire-and-forget, at most once per hour and only when the anomaly set changed.
 *  Never awaited by render. Belongs in the background sync job (see report). */
function notifyWebhook(url: string, anomalies: Awaited<ReturnType<typeof detectCostAnomalies>>): void {
  const digest = anomalies.map((a) => `${a.accountId}:${a.currentHourly.toFixed(2)}`).join("|");
  const now = Date.now();
  if (digest === lastWebhookDigest || now - lastWebhookAt < WEBHOOK_MIN_INTERVAL_MS) return;
  lastWebhookDigest = digest;
  lastWebhookAt = now;
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anomalies }),
    signal: AbortSignal.timeout(5_000),
  }).catch((err: unknown) => console.error("[vmui] anomaly webhook failed", err));
}

export async function CostAnomalyBanner() {
  const anomalies = await detectCostAnomalies();
  if (anomalies.length === 0) return null;
  const t = await getTranslations("dashboard.anomaly");

  if (env.VMUI_ANOMALY_WEBHOOK) notifyWebhook(env.VMUI_ANOMALY_WEBHOOK, anomalies);

  return (
    <div className="space-y-2">
      {anomalies.map((a) => (
        <Alert
          key={a.accountId}
          tone="warning"
          title={t("title", { account: a.accountName })}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/costs">{t("view")}</Link>
            </Button>
          }
        >
          {t(a.ratio > 0 ? "body" : "bodyNoRatio", {
            current: formatUsd(a.currentHourly),
            ratio: a.ratio.toFixed(1),
            median: formatUsd(a.median7dHourly),
            monthly: formatUsd(a.currentHourly * HOURS_PER_MONTH),
          })}
        </Alert>
      ))}
    </div>
  );
}
