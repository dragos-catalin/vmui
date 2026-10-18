"use client";

import { Badge, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import type { AlertFiringRow } from "@/lib/db/schema";
import { BellOff } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

interface Delivery {
  channelName: string;
  ok: boolean;
  error?: string;
}

function parseDeliveries(json: string | null): Delivery[] {
  try {
    return JSON.parse(json ?? "[]") as Delivery[];
  } catch {
    return [];
  }
}

export function AlertFiringsList({ firings }: { firings: AlertFiringRow[] }) {
  const t = useTranslations("observe.alerts.firings");
  const format = useFormatter();

  const columns: ColumnDef<AlertFiringRow>[] = React.useMemo(
    () => [
      {
        id: "firedAt",
        header: t("columns.when"),
        cell: ({ row }) => (
          <time dateTime={row.original.firedAt.toISOString()} className="whitespace-nowrap text-xs text-fg-muted">
            {format.relativeTime(row.original.firedAt)}
          </time>
        ),
      },
      {
        id: "status",
        header: t("columns.status"),
        cell: ({ row }) =>
          row.original.status === "firing" ? (
            <Badge variant="danger" dot>
              {t("status.firing")}
            </Badge>
          ) : (
            <Badge variant="success">{t("status.resolved")}</Badge>
          ),
      },
      {
        id: "metric",
        header: t("columns.metric"),
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.metric} = {format.number(row.original.value, { maximumFractionDigits: 1 })}{" "}
            <span className="text-fg-muted">
              ({row.original.status === "firing" ? t("exceeds") : t("backBelow")} {format.number(row.original.threshold, { maximumFractionDigits: 1 })})
            </span>
          </span>
        ),
      },
      {
        id: "instance",
        header: t("columns.instance"),
        cell: ({ row }) => <code className="block max-w-[12rem] truncate font-mono text-xs text-fg-muted">{row.original.instanceId ?? "—"}</code>,
      },
      {
        id: "deliveries",
        header: t("columns.deliveries"),
        cell: ({ row }) => {
          const ds = parseDeliveries(row.original.deliveryJson);
          if (ds.length === 0) return <span className="text-xs text-fg-muted">—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {ds.map((d, i) => (
                <Badge key={i} variant={d.ok ? "success" : "danger"} title={d.error ?? t("delivered")}>
                  {d.channelName}
                </Badge>
              ))}
            </div>
          );
        },
      },
    ],
    [t, format],
  );

  return (
    <m.div initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
      <DataTable
        columns={columns}
        data={firings}
        dense
        getRowId={(r) => String(r.id)}
        emptyState={<EmptyState illustration="activity" compact icon={<BellOff />} title={t("empty.title")} description={t("empty.description")} />}
      />
    </m.div>
  );
}
