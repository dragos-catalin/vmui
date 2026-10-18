"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { RelativeTime } from "@/components/settings/relative-time";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, X } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import type { BuildRow, InstanceLite, RegistryLite } from "./types";

type StepState = "done" | "active" | "failed" | "pending";

const STATUS_VARIANT: Record<BuildRow["status"], "muted" | "info" | "success" | "danger"> = {
  pending: "muted",
  running: "info",
  success: "success",
  failed: "danger",
};

function stepStates(status: BuildRow["status"]): [StepState, StepState, StepState] {
  switch (status) {
    case "pending":
      return ["active", "pending", "pending"];
    case "running":
      return ["done", "active", "pending"];
    case "success":
      return ["done", "done", "done"];
    case "failed":
      return ["done", "failed", "pending"];
  }
}

export function BuildRunCard({
  build,
  registry,
  instance,
  expanded,
  onToggle,
  index,
}: {
  build: BuildRow;
  registry: RegistryLite | undefined;
  instance: InstanceLite | undefined;
  expanded: boolean;
  onToggle: () => void;
  index: number;
}) {
  const t = useTranslations("ops.builds");
  const steps = stepStates(build.status);
  const labels = [t("steps.queued"), t("steps.building"), t("steps.pushed")] as const;
  const live = build.status === "running" || build.status === "pending";
  const where =
    build.buildLocation === "local"
      ? t("location.local")
      : t("location.remoteOn", { name: instance ? (instance.name ?? instance.providerInstanceId) : (build.instanceId ?? "—") });

  return (
    <m.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.03 }}
      className="surface card-hover overflow-hidden"
      aria-labelledby={`build-${build.id}-title`}
    >
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1 basis-[14rem] space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[build.status]} dot={live}>
              {t(`status.${build.status}`)}
            </Badge>
            {registry && <Badge variant="muted">{registry.name}</Badge>}
          </div>
          <h3 id={`build-${build.id}-title`} className="truncate font-mono text-sm" title={build.imageRef}>
            {build.imageRef}
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{where}</span>
            <span aria-hidden>·</span>
            <RelativeTime date={build.createdAt} />
            {build.finishedAt && (
              <>
                <span aria-hidden>·</span>
                <span>{t("finished")}</span>
                <RelativeTime date={build.finishedAt} />
              </>
            )}
          </p>
        </div>

        <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label={t("timeline")}>
          {steps.map((state, i) => (
            <li key={labels[i]} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "grid size-4 place-items-center rounded-full",
                  state === "done" && "bg-success text-success-fg",
                  state === "active" && "pulse-dot bg-info",
                  state === "failed" && "bg-danger text-danger-fg",
                  state === "pending" && "border border-border",
                )}
                aria-hidden
              >
                {state === "done" && <Check className="size-2.5" strokeWidth={3} />}
                {state === "failed" && <X className="size-2.5" strokeWidth={3} />}
              </span>
              <span className={cn(state === "pending" ? "text-fg-soft" : "text-fg", state === "failed" && "text-danger")}>{labels[i]}</span>
              {i < steps.length - 1 && <span className="ml-1.5 h-px w-4 bg-border" aria-hidden />}
            </li>
          ))}
        </ol>

        <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={expanded} aria-controls={`build-${build.id}-log`} className="ml-auto">
          {expanded ? t("hideOutput") : t("showOutput")}
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden />
        </Button>
      </div>

      {expanded && (
        <div id={`build-${build.id}-log`} className="border-t border-border p-3">
          <LogViewer
            text={build.logOutput ?? ""}
            loading={live && !build.logOutput}
            emptyLabel={t("noLogs")}
            height="max-h-96"
            wrap
            lineTone={(line) => (/error|fatal|denied/i.test(line) ? "danger" : /warn/i.test(line) ? "warning" : /successfully|pushed/i.test(line) ? "success" : undefined)}
          />
        </div>
      )}
    </m.article>
  );
}
