import "server-only";

import { scanCompliance, type Severity } from "@/server/queries/compliance";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { notify } from "@/lib/notifications";

declare global {
  // eslint-disable-next-line no-var
  var __vmuiComplianceScan__: { interval: ReturnType<typeof setInterval> } | undefined;
  // eslint-disable-next-line no-var
  var __vmuiLastComplianceRun__: number | undefined;
  // eslint-disable-next-line no-var
  var __vmuiLastComplianceFingerprint__: string | undefined;
}

const TICK_MS = 60 * 60_000; // hourly check; only emits notifications when a daily cycle elapses
const DAY_MS = 24 * 60 * 60_000;

const NOTIFY_SEV: Record<Severity, "info" | "warning" | "error"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "info",
};

function fingerprint(severityCounts: Record<Severity, number>): string {
  return `${severityCounts.critical}|${severityCounts.high}|${severityCounts.medium}|${severityCounts.low}`;
}

async function runScan(): Promise<void> {
  const last = globalThis.__vmuiLastComplianceRun__ ?? 0;
  if (Date.now() - last < DAY_MS) return;
  try {
    const findings = await scanCompliance();
    globalThis.__vmuiLastComplianceRun__ = Date.now();
    const counts: Record<Severity, number> = {
      critical: findings.filter((f) => f.severity === "critical").length,
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    };
    const fp = fingerprint(counts);
    const total = findings.length;
    // Stored strings are shown verbatim in both locales, so keep them language-neutral:
    // "Σ 7 · C 0 · H 2 · M 3 · L 2" reads the same in RO and EN (the severity legend is on /compliance).
    const summary = `Σ ${total} · C ${counts.critical} · H ${counts.high} · M ${counts.medium} · L ${counts.low}`;
    await db.insert(auditLog).values({
      action: "compliance.scan",
      status: "ok",
      message: summary,
    });
    // Only notify when the picture changed (avoids daily noise on a stable fleet).
    if (fp !== globalThis.__vmuiLastComplianceFingerprint__ && (counts.critical > 0 || counts.high > 0)) {
      const worst = counts.critical > 0 ? "critical" : "high";
      await notify({
        category: "compliance",
        severity: NOTIFY_SEV[worst],
        title: `Compliance · C ${counts.critical} · H ${counts.high}`,
        body: summary,
        href: "/compliance",
      });
    }
    globalThis.__vmuiLastComplianceFingerprint__ = fp;
  } catch (err) {
    await db.insert(auditLog).values({
      action: "compliance.scan",
      status: "error",
      message: err instanceof Error ? err.message : "scan failed",
    });
  }
}

export function ensureComplianceScanRunning(): void {
  if (typeof window !== "undefined") return;
  if (globalThis.__vmuiComplianceScan__) return;
  const interval = setInterval(() => {
    runScan().catch((err) => console.error("[vmui] compliance scan failed", err));
  }, TICK_MS);
  if (typeof interval.unref === "function") interval.unref();
  globalThis.__vmuiComplianceScan__ = { interval };
  // Kick once shortly after boot so dashboards have fresh data.
  setTimeout(() => {
    runScan().catch(() => {
      /* logged elsewhere */
    });
  }, 30_000);
}
