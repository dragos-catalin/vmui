"use client";

import { Badge, Button, DataTable, EmptyState, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { deleteUserAction, updateUserRoleAction } from "@/server/actions/auth";
import { KeyRound, Trash2, Users } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { toResult } from "./adapt";
import { RelativeTime } from "./relative-time";
import { ResetPasswordDialog } from "./reset-password-dialog";

export type UserRole = "admin" | "operator" | "viewer";
const ROLES: UserRole[] = ["admin", "operator", "viewer"];

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export function UsersTable({ users, meId }: { users: UserView[]; meId: string }) {
  const t = useTranslations("settings.users");
  const tc = useTranslations("common");
  const tr = useTranslations("auth.roles");
  const format = useFormatter();
  const confirm = useConfirm();
  const [resetTarget, setResetTarget] = useState<{ id: string; email: string } | null>(null);

  const setRole = useAction(async (userId: string, role: UserRole) => toResult(await updateUserRoleAction({ userId, role })));

  const remove = useAction(async (id: string) => toResult(await deleteUserAction(id)), { success: t("deleted") });

  async function onRemove(u: UserView) {
    const yes = await confirm({
      title: t("confirmDelete", { email: u.email }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
      requireText: u.email,
    });
    if (yes) await remove.run(u.id);
  }

  const runRole = setRole.run;
  const onRole = useCallback(
    async (u: UserView, role: UserRole) => {
      const r = await runRole(u.id, role);
      if (r.ok) toast.success(t("roleUpdated", { role: tr(role) }));
    },
    [runRole, t, tr],
  );

  const columns = useMemo<ColumnDef<UserView, unknown>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: t("columns.user"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium" title={row.original.displayName}>{row.original.displayName}</span>
              {row.original.id === meId && <Badge variant="info">{t("you")}</Badge>}
            </div>
            <code className="block truncate text-xs text-fg-muted" title={row.original.email}>{row.original.email}</code>
          </div>
        ),
      },
      {
        accessorKey: "role",
        header: t("columns.role"),
        cell: ({ row }) => {
          const u = row.original;
          const isSelf = u.id === meId;
          return (
            <Select value={u.role} onValueChange={(v) => void onRole(u, v as UserRole)} disabled={isSelf || setRole.pending}>
              <SelectTrigger aria-label={t("changeRole")} className="h-9 w-auto min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tr(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        },
      },
      {
        accessorKey: "createdAt",
        header: t("columns.created"),
        cell: ({ row }) => <span className="whitespace-nowrap text-fg-muted">{format.dateTime(new Date(row.original.createdAt), { dateStyle: "medium" })}</span>,
      },
      {
        accessorKey: "lastLoginAt",
        header: t("columns.lastSeen"),
        cell: ({ row }) =>
          row.original.lastLoginAt ? (
            <RelativeTime date={row.original.lastLoginAt} className="whitespace-nowrap text-fg-muted" />
          ) : (
            <span className="text-fg-muted">{t("never")}</span>
          ),
      },
    ],
    [t, tr, format, meId, onRole, setRole.pending],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={users}
        dense
        searchable={users.length > 5}
        getRowId={(u) => u.id}
        emptyState={<EmptyState compact icon={<Users />} title={t("count", { count: 0 })} />}
        rowActions={(u) => (
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("resetPassword.action")}
              title={t("resetPassword.action")}
              onClick={() => setResetTarget({ id: u.id, email: u.email })}
            >
              <KeyRound className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void onRemove(u)}
              disabled={remove.pending || u.id === meId}
              aria-label={u.id === meId ? t("cannotDeleteSelf") : t("delete")}
              title={u.id === meId ? t("cannotDeleteSelf") : t("delete")}
            >
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </>
        )}
      />
      <ResetPasswordDialog target={resetTarget} onClose={() => setResetTarget(null)} />
    </>
  );
}
