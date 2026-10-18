"use client";

import { Badge, Button, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import {
    listSessionsAction,
    revokeAllOtherSessionsAction,
    revokeSessionAction,
    type SessionListItem,
} from "@/server/actions/sessions";
import { LogOut, MonitorSmartphone, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toError } from "./adapt";
import { RelativeTime } from "./relative-time";

export function SessionsCard() {
  const t = useTranslations("settings.security.sessions");
  const router = useRouter();
  const [rows, setRows] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setRows(await listSessionsAction());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = useAction(
    async (s: SessionListItem): Promise<ActionResult<boolean>> => {
      const r = await revokeSessionAction(s.id);
      return r.ok ? ok(s.isCurrent) : toError(r);
    },
    {
      success: t("revoked"),
      onSuccess: (wasCurrent) => {
        if (wasCurrent) router.push("/sign-in");
        else void refresh();
      },
    },
  );

  const revokeAll = useAction(
    async (): Promise<ActionResult<number>> => {
      const r = await revokeAllOtherSessionsAction();
      return r.ok ? ok(r.count) : toError({});
    },
    { success: (count) => t("revokedOthers", { count }), onSuccess: () => void refresh() },
  );

  const others = rows.filter((r) => !r.isCurrent).length;

  const columns = useMemo<ColumnDef<SessionListItem, unknown>[]>(() => {
    const rel = (d: Date) => <RelativeTime date={d} className="whitespace-nowrap text-fg-muted" />;
    return [
      {
        accessorKey: "displayName",
        header: t("user"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium" title={row.original.displayName}>{row.original.displayName}</span>
              {row.original.isCurrent && <Badge variant="success">{t("current")}</Badge>}
            </div>
            <code className="block truncate text-2xs text-fg-muted" title={row.original.email}>{row.original.email}</code>
          </div>
        ),
      },
      { accessorKey: "lastSeenAt", header: t("lastSeen"), cell: ({ row }) => rel(row.original.lastSeenAt) },
      { accessorKey: "createdAt", header: t("created"), cell: ({ row }) => rel(row.original.createdAt) },
      { accessorKey: "expiresAt", header: t("expires"), cell: ({ row }) => rel(row.original.expiresAt) },
    ];
  }, [t]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      loading={loading}
      dense
      getRowId={(r) => r.id}
      toolbar={
        <>
          <span className="text-xs text-fg-muted tabular-nums">{t("count", { count: rows.length })}</span>
          {others > 0 && (
            <Button size="sm" variant="outline" onClick={() => void revokeAll.run()} loading={revokeAll.pending}>
              <LogOut className="size-4" aria-hidden /> {t("signOutOthers")}
            </Button>
          )}
        </>
      }
      emptyState={<EmptyState compact icon={<MonitorSmartphone />} title={t("empty")} />}
      rowActions={(s) => (
        <Button size="sm" variant="ghost" onClick={() => void revoke.run(s)} disabled={revoke.pending}>
          {s.isCurrent ? <LogOut className="size-4" aria-hidden /> : <Trash2 className="size-4 text-danger" aria-hidden />}
          {s.isCurrent ? t("signOut") : t("revoke")}
        </Button>
      )}
    />
  );
}
